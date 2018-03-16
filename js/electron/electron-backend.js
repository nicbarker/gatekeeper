// -------------------------------------------------------------
// This helper imitates a backend API when using the Electron
// desktop app. It saves a flat file JSON structure in the application
// userdata folder.
// -------------------------------------------------------------

import path from 'path'
import { remote } from 'electron'
import fs from 'fs'
import uuidv4 from 'uuid/v4'
import os from 'os'
import _ from 'lodash'
import FCS from 'fcs'
import * as d3 from "d3"
import { getPlotImageKey, heatMapRGBForValue, getScales, getPolygonCenter } from '../lib/utilities'
import constants from '../lib/constants'
import PersistentHomology from '../lib/persistent-homology.js'
import { fork } from 'child_process'
import GrahamScan from '../lib/graham-scan.js'
import pointInsidePolygon from 'point-in-polygon'
import { distanceToPolygon, distanceBetweenPoints } from 'distance-to-polygon'
import applicationReducer from '../reducers/application-reducer'
import { updateSample, removeSample, setSamplePlotImage } from '../actions/sample-actions'
import { updateGateTemplate, removeGateTemplate } from '../actions/gate-template-actions'
import { createWorkspace, selectWorkspace, removeWorkspace,
    createSampleAndAddToWorkspace, createSubSampleAndAddToWorkspace, selectSample,
    createGateTemplateAndAddToWorkspace, selectGateTemplate,
    createGateTemplateGroupAndAddToWorkspace } from '../actions/workspace-actions'

window.d3 = d3

// Debug imports below
// import getImageForPlotBackend from '../lib/get-image-for-plot'
const jobQueue = []
const jobListeners = {}
const nextWorkerIndex = 0

for (let i = 0; i < os.cpus().length; i++) {
    // Fork a new node process for doing CPU intensive jobs
    const workerFork = fork(__dirname + '/subprocess-wrapper.js', [], { silent: true })

    workerFork.stdout.on('data', (result) => {
        console.log(result.toString('utf8'))
    })
    workerFork.stderr.on('data', (result) => {
        console.log(result.toString('utf8'))
    })

    workerFork.on('message', (data) => {
        // console.log(data)
        if (data.type === 'idle') {
            if (jobQueue.length > 0) {
                console.log('sending job', jobQueue[0], 'to idle worker')
                workerFork.send(jobQueue.splice(0, 1)[0])
            }
        } else {
            if (jobListeners[data.jobId]) {
                jobListeners[data.jobId](data)
            }
        }
    })

    setInterval(() => {
        workerFork.send({ type: 'heartbeat'})
    }, 1000)
}

// Wrap the read and write file functions from FS in promises
const readFile = (path, opts = 'utf8') => {
    return new Promise((res, rej) => {
        fs.readFile(path, opts, (err, data) => {
            if (err) rej(err)
            else res(data)
        })
    })
}

// Wrap the read and write file functions from FS in promises
const readFileBuffer = (path) => {
    return new Promise((res, rej) => {
        fs.readFile(path, (err, buffer) => {
            if (err) rej(err)
            else res(buffer)
        })
    })
}

const writeFile = (path, data, opts = 'utf8') => {
    return new Promise((res, rej) => {
        fs.writeFile(path, data, opts, (err) => {
            if (err) rej(err)
            else res()
        })
    })
}

// The default empty state of the application on first load
const defaultState = {
    samples: [],
    workspaces: [],
    gates: [],
    selectedWorkspaceId: null
}

const filteredSampleAttributes = ['includeEventIds']

// Cache the state after it's been read from disk, then write it back after every update
let currentState = {}

let reduxStore = {}

const FCSFileCache = {}

const populationDataCache = {}

const getFCSFileFromPath = async (filePath) => {
    if (FCSFileCache[filePath]) {
        return FCSFileCache[filePath]
    }
    // Read in the data from the FCS file, and emit another action when finished
    const buffer = await readFileBuffer(filePath)
    const FCSFile = new FCS({ dataFormat: 'asNumber', eventsToRead: -1 }, buffer)
    FCSFileCache[filePath] = FCSFile
    return FCSFile
}

// Generates an image for a 2d scatter plot
const getImageForPlot = async (sample, subPopulation, options) => {
    if (sample.plotImages[getPlotImageKey(options)]) { return sample.plotImages[getPlotImageKey(options)] }

    const jobId = uuidv4()

    jobQueue.push({ jobId: jobId, type: 'get-image-for-plot', payload: { sample, subPopulation, options } })
    const imagePath = await new Promise((resolve, reject) => {
        jobListeners[jobId] = function (result) {
            if (result.jobId === jobId) {
                if (result.type === 'error') {
                    console.log('Error generating image:', result.error)
                    delete jobListeners[jobId]
                    reject(result.error)
                } else if (result.type === 'loading-update') {
                    loadingMessage = result.data
                } else if (result.type === 'complete') {
                    delete jobListeners[jobId]
                    resolve(result.data)
                }
            }
        }
    })
    
    return imagePath
    // return await getImageForPlotBackend(sample, subPopulation, options)
}

// Calculate 1d density using kernel density estimation for drawing histograms
function kernelDensityEstimator(kernel, X) {
  return function(V) {
    return X.map(function(x) {
      return [x, d3.mean(V, function(v) { return kernel(x - v); })];
    });
  };
}

function kernelEpanechnikov(k) {
  return function(v) {
    return Math.abs(v /= k) <= 1 ? 0.75 * (1 - v * v) / k : 0;
  };
}

// -------------------------------------------------------------
// Exported functions below
// -------------------------------------------------------------

// Keep a copy of the redux store and dispatch events
export const setStore = (store) => { reduxStore = store }

// Write the whole session to the disk
export const saveSessionToDisk = async function () {
    // Save the new state to the disk
    const sessionFilePath = path.join(remote.app.getPath('userData'), 'session2.json')
    fs.writeFile(sessionFilePath, JSON.stringify(currentState, null, 4), () => {})
}

// Load the workspaces and samples the user last had open when the app was used
export const api = {
    getSession: async function () {
        const sessionFilePath = path.join(remote.app.getPath('userData'), 'session2.json')
        try {
            currentState = JSON.parse(await readFile(sessionFilePath))
        } catch (error) {
            // If there's no session file, create one
            if (error.code === 'ENOENT') {
                try {
                    writeFile(sessionFilePath, JSON.stringify(defaultState))
                    currentState = defaultState
                } catch (error) {
                    return { error: error }    
                }
            } else {
                return { error: error }
            }
        }

        // Clone the whole state so that object references aren't accidentally reused
        const uiState = _.cloneDeep(currentState)

        // Filter out the attributes that are only for the backend,
        // e.g. large FCS file data
        for (let sample of uiState.samples) {
            for (let filteredAttribute of filteredSampleAttributes) {
                delete sample[filteredAttribute]
            }
        }

        store.dispatch({ type: 'SET_SESSION_STATE', payload: uiState })

        // After reading the session, if there's no workspace, create a default one
        if (currentState.workspaces.length === 0) {
            const workspaceId = await api.createWorkspace({ title: 'New Workspace', description: 'New Workspace' })
            // Add an empty Gate Template
            api.createGateTemplateAndAddToWorkspace(workspaceId, { title: 'New Gating Strategy' })
        }
    },

    createWorkspace: async function (parameters) {
        const workspaceId = uuidv4()

        const newWorkspace = {
            id: workspaceId,
            title: parameters.title,
            description: parameters.description,
            sampleIds: [],
            gateTemplateIds: [],
            gateTemplateGroupIds: []
        }

        const createAction = createWorkspace(newWorkspace)
        currentState = applicationReducer(currentState, createAction)
        store.dispatch(createAction)

        saveSessionToDisk()

        return newWorkspace.id
    },

    selectWorkspace: async function (workspaceId) {
        const selectAction = selectWorkspace(workspaceId)
        currentState = applicationReducer(currentState, selectAction)
        store.dispatch(selectWorkspace(workspaceId))

        saveSessionToDisk()
    },

    // TODO: Select the closest workspace after removing it
    removeWorkspace: async function (workspaceId) {
        const removeAction = removeWorkspace(workspaceId)
        currentState = applicationReducer(currentState, removeAction)
        store.dispatch(removeAction)

        saveSessionToDisk()
    },

    createGateTemplateAndAddToWorkspace: async function (workspaceId, gateTemplateParameters) {
        const gateTemplateId = uuidv4()

        // Create a Gate Template for this parameter combination
        const gateTemplate = {
            id: gateTemplateId,
            creator: gateTemplateParameters.creator,
            title: gateTemplateParameters.title,
            xGroup: gateTemplateParameters.xGroup,
            yGroup: gateTemplateParameters.yGroup,
            typeSpecificData: gateTemplateParameters.typeSpecificData,
        }

        const createGateTemplateAction = createGateTemplateAndAddToWorkspace(workspaceId, gateTemplate)
        currentState = applicationReducer(currentState, createGateTemplateAction)
        store.dispatch(createGateTemplateAction)

        saveSessionToDisk()
    },

    // Update a gate template with arbitrary parameters
    updateGateTemplate: async function (gateTemplateId, parameters) {
        const updateAction = updateGateTemplate(gateTemplateId, parameters)

        currentState = applicationReducer(currentState, updateAction)
        store.dispatch(updateAction)

        // Update any child templates that depend on these
        const templateGroup = _.find(currentState.gateTemplateGroups, g => g.childGateTemplateIds.includes(gateTemplateId))
        await api.recalculateGateTemplateGroup(templateGroup.id)

        saveSessionToDisk()
    },

    selectGateTemplate: async function (gateTemplateId, workspaceId) {
        const selectAction = selectGateTemplate(gateTemplateId, workspaceId)

        currentState = applicationReducer(currentState, selectAction)
        store.dispatch(selectAction)

        // Select the related sample
        const relatedSample = _.find(currentState.samples, s => s.gateTemplateId === gateTemplateId)
        if (relatedSample) {
            await api.selectSample(relatedSample.id, workspaceId)
        }

        saveSessionToDisk()
    },

    removeGateTemplate: async function (gateTemplateId) {
        const removeAction = removeGateTemplate(gateTemplateId)

        currentState = applicationReducer(currentState, removeAction)
        store.dispatch(removeAction)

        saveSessionToDisk()
    },

    recalculateGateTemplateGroup: async function (gateTemplateGroupId) {
        const templateGroup = _.find(currentState.gateTemplateGroups, g => g.id === gateTemplateGroupId)
        if (templateGroup.creator === constants.GATE_CREATOR_PERSISTENT_HOMOLOGY) {
            const parentSamples = _.filter(currentState.samples, s => templateGroup.parentGateTemplateId === s.gateTemplateId)
            for (let parentSample of parentSamples) {
                await api.calculateHomology(parentSample.id, {
                    selectedXParameterIndex: templateGroup.selectedXParameterIndex,
                    selectedYParameterIndex: templateGroup.selectedYParameterIndex,
                    selectedXScale: templateGroup.selectedXScale,
                    selectedYScale: templateGroup.selectedYScale,
                    selectedMachineType: templateGroup.selectedMachineType
                })
            }
            for (let sample of _.filter(currentState.samples, s => templateGroup.childGateTemplateIds.includes(s.gateTemplateId))) {
                // If homology was succesful, the sample will now have child samples
                for (let subSampleId of sample.subSampleIds) {
                    await api.applyGateTemplatesToSample(subSampleId)
                }
            }
        }
    },

    applyGateTemplatesToSample: async function (sampleId) {
        const sample = _.find(currentState.samples, s => s.id === sampleId)
        // Find all template groups that apply to this sample
        const templateGroups = _.filter(currentState.gateTemplateGroups, g => g.parentGateTemplateId === sample.gateTemplateId)
        for (let templateGroup of templateGroups) {
            if (templateGroup.creator === constants.GATE_CREATOR_PERSISTENT_HOMOLOGY) {
                const population = await api.getPopulationDataForSample(sampleId, {
                    selectedXParameterIndex: templateGroup.selectedXParameterIndex,
                    selectedYParameterIndex: templateGroup.selectedYParameterIndex,
                    selectedXScale: templateGroup.selectedXScale,
                    selectedYScale: templateGroup.selectedYScale,
                    selectedMachineType: templateGroup.selectedMachineType
                })

                // Generate the cached images
                const imageForPlot = await getImageForPlot(sample, population, {
                    selectedXParameterIndex: templateGroup.selectedXParameterIndex,
                    selectedYParameterIndex: templateGroup.selectedYParameterIndex,
                    selectedXScale: templateGroup.selectedXScale,
                    selectedYScale: templateGroup.selectedYScale,
                    selectedMachineType: templateGroup.selectedMachineType
                })

                const imageAction = await setSamplePlotImage(sample.id, getPlotImageKey(templateGroup), imageForPlot)
                currentState = applicationReducer(currentState, imageAction)
                store.dispatch(imageAction)

                await api.calculateHomology(sampleId, {
                    selectedXParameterIndex: templateGroup.selectedXParameterIndex,
                    selectedYParameterIndex: templateGroup.selectedYParameterIndex,
                    selectedXScale: templateGroup.selectedXScale,
                    selectedYScale: templateGroup.selectedYScale,
                    selectedMachineType: templateGroup.selectedMachineType
                })
            }
        }

        // If homology was succesful, the sample will now have child samples
        const updatedSample = _.find(currentState.samples, s => s.id === sampleId)
        for (let subSampleId of updatedSample.subSampleIds) {
            await api.applyGateTemplatesToSample(subSampleId)
        }
    },

    createGateTemplateGroupAndAddToWorkspace: async function (workspaceId, gateTemplateGroupParameters) {
        const gateTemplateGroupId = uuidv4()

        // Create a Gate Template for this parameter combination
        const gateTemplateGroup = {
            id: gateTemplateGroupId,
            creator: gateTemplateGroupParameters.creator,
            title: gateTemplateGroupParameters.title,
            parentGateTemplateId: gateTemplateGroupParameters.parentGateTemplateId,
            childGateTemplateIds: gateTemplateGroupParameters.childGateTemplateIds,
            selectedXParameterIndex: gateTemplateGroupParameters.selectedXParameterIndex,
            selectedYParameterIndex: gateTemplateGroupParameters.selectedYParameterIndex,
            selectedXScale: gateTemplateGroupParameters.selectedXScale,
            selectedYScale: gateTemplateGroupParameters.selectedYScale,
            selectedMachineType: gateTemplateGroupParameters.selectedMachineType,
            expectedGates: gateTemplateGroupParameters.expectedGates,
            typeSpecificData: gateTemplateGroupParameters.typeSpecificData,
        }

        const createGateTemplateGroupAction = createGateTemplateGroupAndAddToWorkspace(workspaceId, gateTemplateGroup)
        currentState = applicationReducer(currentState, createGateTemplateGroupAction)
        store.dispatch(createGateTemplateGroupAction)

        saveSessionToDisk()
    },

    createSampleAndAddToWorkspace: async function (workspaceId, gateTemplateId, sampleParameters) {
        const sampleId = uuidv4()

        // Find the associated workspace
        const workspace = _.find(currentState.workspaces, w => w.id === workspaceId)

        let sample = {
            id: sampleId,
            type: sampleParameters.type,
            filePath: sampleParameters.filePath,
            title: sampleParameters.title,
            description: sampleParameters.description,
            gateTemplateId: gateTemplateId || currentState.workspaces.gateTemplates[0].id,
            // Below are defaults
            selectedXParameterIndex: 49,
            selectedYParameterIndex: 26,
            selectedMachineType: constants.MACHINE_FLORESCENT,
            selectedXScale: constants.SCALE_LOG,
            selectedYScale: constants.SCALE_LOG,
            loading: true,
            loadingMessage: 'Reading FCS file and generating densities...',
            plotImages: {}
        }

        const createAction = createSampleAndAddToWorkspace(workspaceId, sample)

        currentState = applicationReducer(currentState, createAction)
        store.dispatch(createAction)

        const population = await api.getPopulationDataForSample(sampleId, {
            selectedXParameterIndex: sample.selectedXParameterIndex,
            selectedYParameterIndex: sample.selectedYParameterIndex,
            selectedXScale: sample.selectedXScale,
            selectedYScale: sample.selectedYScale,
            selectedMachineType: sample.selectedMachineType
        })

        const updateAction = updateSample(sampleId, { loading: true, loadingMessage: 'Generating image for plot...', populationCount: population.populationCount, FCSParameters: population.FCSParameters, selectedMachineType: population.selectedMachineType })

        currentState = applicationReducer(currentState, updateAction)
        store.dispatch(updateAction)

        const updatedSample = _.find(currentState.samples, s => s.id === sampleId)
        // Generate the cached images
        const imageForPlot = await getImageForPlot(updatedSample, population, {
            selectedXParameterIndex: updatedSample.selectedXParameterIndex,
            selectedYParameterIndex: updatedSample.selectedYParameterIndex,
            selectedXScale: updatedSample.selectedXScale,
            selectedYScale: updatedSample.selectedYScale,
            selectedMachineType: updatedSample.selectedMachineType
        })
        const imageAction = await setSamplePlotImage(updatedSample.id, getPlotImageKey(updatedSample), imageForPlot)
        currentState = applicationReducer(currentState, imageAction)
        store.dispatch(imageAction)

        // Recursively apply the existing gating hierarchy
        await api.applyGateTemplatesToSample(updatedSample.id)

        const updateActionFinished = updateSample(sampleId, { loading: false, loadingMessage: null })

        currentState = applicationReducer(currentState, updateActionFinished)
        store.dispatch(updateActionFinished)

        saveSessionToDisk()
    },

    createSubSampleAndAddToWorkspace: async function (workspaceId, parentSampleId, sampleParameters, gateParameters) {
        const sampleId = sampleParameters.id || uuidv4()
        const gateId = gateParameters.id || uuidv4()

        const parentSample = _.find(currentState.samples, s => s.id === parentSampleId)

        let sample = {
            id: sampleId,
            type: sampleParameters.type,
            title: sampleParameters.title,
            description: sampleParameters.description,
            filePath: parentSample.filePath,
            gateTemplateId: sampleParameters.gateTemplateId,
            selectedXParameterIndex: parentSample.selectedXParameterIndex,
            selectedYParameterIndex: parentSample.selectedYParameterIndex,
            selectedXScale: parentSample.selectedXScale,
            selectedYScale: parentSample.selectedYScale,
            FCSParameters: _.clone(parentSample.FCSParameters),
            statistics: _.clone(parentSample.statistics),
            selectedMachineType: parentSample.selectedMachineType,
            // Below are defaults
            subSampleIds: [],
            plotImages: {}
        }

        const gate = {
            id: gateId,
            type: gateParameters.type,
            gateData: gateParameters.gateData,
            selectedXParameterIndex: gateParameters.selectedXParameterIndex,
            selectedYParameterIndex: gateParameters.selectedYParameterIndex,
            selectedXScale: gateParameters.selectedXScale,
            selectedYScale: gateParameters.selectedYScale,
            gateTemplateId: gateParameters.gateTemplateId,
            xCutoffs: gateParameters.xCutoffs,
            yCutoffs: gateParameters.yCutoffs
        }

        // Store the events that were captured within the subsample but don't add them to the redux state
        const FCSFile = await getFCSFileFromPath(sample.filePath)

        const includeEventIds = []

        if (gate.type === constants.GATE_TYPE_POLYGON) {
            for (let i = 0; i < FCSFile.dataAsNumbers.length; i++) {
                if (pointInsidePolygon([FCSFile.dataAsNumbers[i][sample.selectedXParameterIndex], FCSFile.dataAsNumbers[i][sample.selectedYParameterIndex]], gate.gateData)) {
                    includeEventIds[i] = true
                } else {
                    if (gate.xCutoffs && FCSFile.dataAsNumbers[i][sample.selectedXParameterIndex] === 0 && FCSFile.dataAsNumbers[i][sample.selectedYParameterIndex] >= gate.xCutoffs[0] && FCSFile.dataAsNumbers[i][sample.selectedYParameterIndex] <= gate.xCutoffs[1]) {
                        includeEventIds[i] = true
                    }
                    if (gate.yCutoffs && FCSFile.dataAsNumbers[i][sample.selectedYParameterIndex] === 0 && FCSFile.dataAsNumbers[i][sample.selectedXParameterIndex] >= gate.yCutoffs[0] && FCSFile.dataAsNumbers[i][sample.selectedXParameterIndex] <= gate.yCutoffs[1]) {
                        includeEventIds[i] = true
                    }
                }
            }
        }

        // If there was no title specified, auto generate one
        let title = 'Subsample'

        sample.populationCount = includeEventIds.length

        const backendSample = _.cloneDeep(sample)
        backendSample.includeEventIds = includeEventIds

        currentState = applicationReducer(currentState, createSubSampleAndAddToWorkspace(workspaceId, parentSampleId, backendSample, gate))
        store.dispatch(createSubSampleAndAddToWorkspace(workspaceId, parentSampleId, sample, gate))

        const population = await api.getPopulationDataForSample(sampleId, {
            selectedXParameterIndex: backendSample.selectedXParameterIndex,
            selectedYParameterIndex: backendSample.selectedYParameterIndex,
            selectedXScale: backendSample.selectedXScale,
            selectedYScale: backendSample.selectedYScale,
            selectedMachineType: backendSample.selectedMachineType
        })

        // Generate the cached images
        const imageForPlot = await getImageForPlot(backendSample, population, {
            selectedXParameterIndex: sample.selectedXParameterIndex,
            selectedYParameterIndex: sample.selectedYParameterIndex,
            selectedXScale: sample.selectedXScale,
            selectedYScale: sample.selectedYScale,
            selectedMachineType: sample.selectedMachineType,
            width: 600,
            height: 460
        })
        const imageAction = await setSamplePlotImage(backendSample.id, getPlotImageKey(backendSample), imageForPlot)
        currentState = applicationReducer(currentState, imageAction)
        store.dispatch(imageAction)

        saveSessionToDisk()
    },

    removeSample: async function (sampleId) {
        const removeAction = removeSample(sampleId)

        currentState = applicationReducer(currentState, removeAction)
        store.dispatch(removeAction)

        saveSessionToDisk()
    },

    selectSample: async function (sampleId, workspaceId) {
        const selectAction = selectSample(sampleId, workspaceId)

        currentState = applicationReducer(currentState, selectAction)
        store.dispatch(selectAction)

        saveSessionToDisk()
    },

    // Update a sample with arbitrary parameters
    updateSample: async function (sampleId, parameters) {
        let updateAction = updateSample(sampleId, _.merge(parameters, { loading: true, loadingMessage: 'Reading FCS file and generating densities...' }))
        currentState = applicationReducer(currentState, updateAction)
        store.dispatch(updateAction)

        const sample = _.find(currentState.samples, s => s.id === sampleId)

        const population = await api.getPopulationDataForSample(sampleId, sample)

        updateAction = updateSample(sampleId, _.merge(parameters, { loading: true, loadingMessage: 'Generating image for plot...' }))
        currentState = applicationReducer(currentState, updateAction)
        store.dispatch(updateAction)
        // Generate the cached images
        const imageForPlot = await getImageForPlot(sample, population, {
            selectedXParameterIndex: sample.selectedXParameterIndex,
            selectedYParameterIndex: sample.selectedYParameterIndex,
            selectedXScale: sample.selectedXScale,
            selectedYScale: sample.selectedYScale,
            selectedMachineType: sample.selectedMachineType,
            width: 600,
            height: 460
        })
        const imageAction = await setSamplePlotImage(sample.id, getPlotImageKey(sample), imageForPlot)
        currentState = applicationReducer(currentState, imageAction)
        store.dispatch(imageAction)

        const updateActionFinished = updateSample(sampleId, _.merge(parameters, { loading: false, loadingMessage: null }))

        currentState = applicationReducer(currentState, updateActionFinished)
        store.dispatch(updateActionFinished)

        saveSessionToDisk()
    },

    // Performs persistent homology calculation to automatically create gates on a sample
    // If a related gateTemplate already exists it will be applied, otherwise a new one will be created.
    // Options shape:
    //    {
    //        selectedXParameterIndex,
    //        selectedYParameterIndex,
    //        selectedXScale,
    //        selectedYScale,
    //        selectedMachineType
    //    }
    calculateHomology: async function (sampleId, options) {
        console.log('Calculating homology for parameters', options.selectedXParameterIndex, options.selectedYParameterIndex)
        const sample = _.find(currentState.samples, s => s.id === sampleId)
        const workspace = _.find(currentState.workspaces, w => w.sampleIds.includes(sampleId))

        let gateTemplateGroup = _.find(currentState.gateTemplateGroups, (group) => {
            return group.parentGateTemplateId === sample.gateTemplateId 
                && group.selectedXParameterIndex === options.selectedXParameterIndex
                && group.selectedYParameterIndex === options.selectedYParameterIndex
                && group.selectedXScale === options.selectedXScale
                && group.selectedYScale === options.selectedYScale
                && group.selectedMachineType === options.selectedMachineType
        })

        if (!sample) { console.log('Error in calculateHomology(): no sample with id ', sampleId, 'was found'); return }
        // Dispatch a redux action to mark the sample as loading
        let loadingMessage = 'Creating gates using Persistent Homology...'
        const loadingStartedAction = updateSample(sampleId, { loading: true, loadingMessage })
        store.dispatch(loadingStartedAction)

        let population = await api.getPopulationDataForSample(sampleId, options)

        // Generate the cached images
        const imageForPlot = await getImageForPlot(sample, population, options)

        const imageAction = await setSamplePlotImage(sample.id, getPlotImageKey(options), imageForPlot)
        currentState = applicationReducer(currentState, imageAction)
        store.dispatch(imageAction)

        let homologyOptions = { sample, population }

        // If there are already gating templates defined for this parameter combination
        if (gateTemplateGroup) {
            const gateTemplates = _.filter(currentState.gateTemplates, gt => gateTemplateGroup.childGateTemplateIds.includes(gt.id))
            homologyOptions = _.merge(homologyOptions, gateTemplateGroup.typeSpecificData)
            homologyOptions.gateTemplates = gateTemplates.map(g => _.clone(g))
        }

        const intervalToken = setInterval(() => {
            const loadingPercentageAction = updateSample(sampleId, { loading: true, loadingMessage })
            store.dispatch(loadingPercentageAction)
        }, 500)

        const jobId = uuidv4()

        if (gateTemplateGroup) {
            console.log("FIND PEAK WITH TEMPLATE")
            jobQueue.push({ jobId: jobId, type: 'find-peaks-with-template', payload: homologyOptions })
        } else {
            jobQueue.push({ jobId: jobId, type: 'find-peaks', payload: homologyOptions })
        }

        let handleResult
        const truePeaks = await new Promise((resolve, reject) => {
            jobListeners[jobId] = function (result) {
                if (result.jobId === jobId) {
                    if (result.type === 'error') {
                        console.log('Error calculating homology:', result.error)
                        delete jobListeners[jobId]
                        reject(result.error)
                    } else if (result.type === 'loading-update') {
                        loadingMessage = result.data
                    } else if (result.type === 'complete') {
                        delete jobListeners[jobId]
                        resolve(result.data)
                    }
                }
            }
        })

        clearInterval(intervalToken)

        // Offset the entire graph and add histograms if we're looking at cytof data
        let xOffset = options.selectedMachineType === constants.MACHINE_CYTOF ? constants.CYTOF_HISTOGRAM_WIDTH : 0
        let yOffset = options.selectedMachineType === constants.MACHINE_CYTOF ? constants.CYTOF_HISTOGRAM_HEIGHT : 0

        const scales = getScales({
            selectedXScale: options.selectedXScale,
            selectedYScale: options.selectedYScale,
            xRange: [ sample.FCSParameters[options.selectedXParameterIndex].statistics.min, sample.FCSParameters[options.selectedXParameterIndex].statistics.max ],
            yRange: [ sample.FCSParameters[options.selectedYParameterIndex].statistics.min, sample.FCSParameters[options.selectedYParameterIndex].statistics.max ],
            width: constants.PLOT_WIDTH - xOffset,
            height: constants.PLOT_HEIGHT - yOffset
        })

        const gates = truePeaks.map((peak) => {
            // Convert the gate polygon back into real space
            for (let i = 0; i < peak.polygon.length; i++) {
                peak.polygon[i][0] = scales.xScale.invert(peak.polygon[i][0])
                peak.polygon[i][1] = scales.yScale.invert(peak.polygon[i][1])
            }

            const gate = {
                type: constants.GATE_TYPE_POLYGON,
                gateData: peak.polygon,
                selectedXParameterIndex: options.selectedXParameterIndex,
                selectedYParameterIndex: options.selectedYParameterIndex,
                selectedXScale: options.selectedXScale,
                selectedYScale: options.selectedYScale,
                gateCreator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                gateCreatorData: peak.homologyParameters
            }

            if (options.selectedMachineType === constants.MACHINE_CYTOF) {
                // On the cytof, add any zero cutoffs to gates
                if (peak.xCutoffs) {
                    gate.xCutoffs = [ scales.yScale.invert(peak.xCutoffs[0]), scales.yScale.invert(peak.xCutoffs[1]) ]
                }
                if (peak.yCutoffs) {
                    gate.yCutoffs = [ scales.xScale.invert(peak.yCutoffs[0]), scales.xScale.invert(peak.yCutoffs[1]) ]
                }
            }

            return gate
        })

        if (!gateTemplateGroup) {
            // Create a Gate Template Group for this parameter combination
            const newGateTemplateGroup = {
                id: uuidv4(),
                creator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                selectedXParameterIndex: options.selectedXParameterIndex,
                selectedYParameterIndex: options.selectedYParameterIndex,
                selectedXScale: options.selectedXScale,
                selectedYScale: options.selectedYScale,
                selectedMachineType: options.selectedMachineType,
                parentGateTemplateId: sample.gateTemplateId,
                childGateTemplateIds: [],
                expectedGates: [],
                typeSpecificData: {}
            }

            const newGateTemplates = gates.map((gate, index) => {
                const gateTemplate = {
                    id: uuidv4(),
                    title: sample.FCSParameters[options.selectedXParameterIndex].label + (truePeaks[index].xGroup === 0 ? ' (LOW) ' : ' (HIGH) ') + sample.FCSParameters[options.selectedYParameterIndex].label + (truePeaks[index].yGroup === 1 ? ' (LOW)' : ' (HIGH)'),
                    creator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                    xGroup: truePeaks[index].xGroup,
                    yGroup: truePeaks[index].yGroup,
                    typeSpecificData: truePeaks[index].homologyParameters
                }
                newGateTemplateGroup.childGateTemplateIds.push(gateTemplate.id)
                gate.gateTemplateId = gateTemplate.id

                const createGateTemplateAction = createGateTemplateAndAddToWorkspace(workspace.id, gateTemplate)
                currentState = applicationReducer(currentState, createGateTemplateAction)
                store.dispatch(createGateTemplateAction)
                return gateTemplate
            })

            const createGateTemplateGroupAction = createGateTemplateGroupAndAddToWorkspace(workspace.id, newGateTemplateGroup)
            currentState = applicationReducer(currentState, createGateTemplateGroupAction)
            store.dispatch(createGateTemplateGroupAction)
        } else {
            const gateTemplates = _.filter(currentState.gateTemplates, g => gateTemplateGroup.childGateTemplateIds.includes(g.id))
            truePeaks.map((peak, index) => {
                gates[index].gateTemplateId = _.find(gateTemplates, gt => gt.xGroup === peak.xGroup && gt.yGroup === peak.yGroup).id
            })

            // Delete previous gates on this plot
            for (let gate of _.filter(currentState.gates, g => gateTemplateGroup.childGateTemplateIds.includes(g.gateTemplateId) && g.parentSampleId === sampleId)) {
                await api.removeSample(gate.childSampleId)
            }
        }


        for (let i = 0; i < gates.length; i++) {
            const gate = gates[i]
            console.log("CREATING NEW GATE", gate)
            api.createSubSampleAndAddToWorkspace(
                workspace.id,
                sampleId,
                {
                    filePath: sample.filePath,
                    FCSParameters: sample.FCSParameters,
                    plotImages: {},
                    subSampleIds: [],
                    gateTemplateId: gate.gateTemplateId,
                    selectedXParameterIndex: options.selectedXParameterIndex,
                    selectedYParameterIndex: options.selectedYParameterIndex,
                    selectedXScale: options.selectedXScale,
                    selectedYScale: options.selectedYScale,
                },
                gate,
            )
        }

        // Dispatch a redux action to mark the sample as finished loading
        const loadingFinishedAction = updateSample(sampleId, { loading: false, loadingMessage: null })
        store.dispatch(loadingFinishedAction)
    },

    recursiveHomology: async (sampleId) => {
        const sample = _.find(currentState.samples, s => s.id === sampleId)
        const workspace = _.find(currentState.workspaces, w => w.sampleIds.includes(sampleId))

        for (let x = 0; x < sample.FCSParameters.length; x++) {
            for (let y = x + 1; y < sample.FCSParameters.length; y++) {
                if (sample.FCSParameters[x].label === sample.FCSParameters[x].key || sample.FCSParameters[y].label === sample.FCSParameters[y].key) {
                    continue
                }

                const options = {
                    selectedXParameterIndex: x,
                    selectedYParameterIndex: y,
                    selectedXScale: constants.SCALE_LOG,
                    selectedYScale: constants.SCALE_LOG,
                    selectedMachineType: sample.selectedMachineType
                }

                api.calculateHomology(sample.id, options)
            }
        }
    },

    getPopulationDataForSample: async (sampleId, options) => {
        const key = `${sampleId}-${options.selectedXParameterIndex}_${options.selectedXScale}-${options.selectedYParameterIndex}_${options.selectedYScale}`
        if (populationDataCache[key]) {
            return populationDataCache[key]
        }
        // Find the related sample
        const sample = _.find(currentState.samples, s => s.id === sampleId)

        const jobId = uuidv4()

        jobQueue.push({ jobId: jobId, type: 'get-population-data', payload: { sample: sample, options: options } })
        const population = await new Promise((resolve, reject) => {
            jobListeners[jobId] = function (result) {
                if (result.jobId === jobId) {
                    if (result.type === 'error') {
                        console.log('Error calculating population:', result.error)
                        delete jobListeners[jobId]
                        reject(result.error)
                    } else if (result.type === 'loading-update') {
                        loadingMessage = result.data
                    } else if (result.type === 'complete') {
                        delete jobListeners[jobId]
                        resolve(result.data)
                    }
                }
            }
        })

        populationDataCache[key] = population
        return populationDataCache[key]
    }
}