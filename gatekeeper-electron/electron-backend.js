// -------------------------------------------------------------
// This helper imitates a backend API when using the Electron
// desktop app. It saves a flat file JSON structure in the application
// userdata folder.
// -------------------------------------------------------------

import path from 'path'
import { remote, ipcRenderer } from 'electron'
const { dialog } = remote
import fs from 'fs'
import hull from 'hull.js'
import uuidv4 from 'uuid/v4'
import * as d3 from "d3"
import os from 'os'
import http2 from 'http2'
import mkdirp from 'mkdirp'
import merge from 'lodash.merge'
import { getPlotImageKey, heatMapRGBForValue, getScales, getPolygonCenter, getPolygonBoundaries, getAxisGroups } from '../gatekeeper-utilities/utilities'
import constants from '../gatekeeper-utilities/constants'
import { fork } from 'child_process'
import ls from 'ls'
import rimraf from 'rimraf'
import createHttpsCertificate from './create-https-certificate'
import polygonsIntersect from 'polygon-overlap'
import area from 'area-polygon'
import md5 from 'md5'
import { distanceToPolygon, distanceBetweenPoints } from 'distance-to-polygon'
import isDev from 'electron-is-dev'
import { breakLongLinesIntoPoints, fixOverlappingPolygonsUsingZipper } from '../gatekeeper-utilities/polygon-utilities'
import applicationReducer from '../gatekeeper-frontend/reducers/application-reducer'
import { addOpenWorkspace, setPlotDimensions, setPlotDisplayDimensions, toggleShowDisabledParameters } from '../gatekeeper-frontend/actions/application-actions'
import { createGate } from '../gatekeeper-frontend/actions/gate-actions'
import { createGateTemplate, updateGateTemplate, removeGateTemplate } from '../gatekeeper-frontend/actions/gate-template-actions'
import { createGateTemplateGroup, updateGateTemplateGroup, removeGateTemplateGroup, addGateTemplateToGroup } from '../gatekeeper-frontend/actions/gate-template-group-actions'
import { createFCSFile, updateFCSFile, removeFCSFile } from '../gatekeeper-frontend/actions/fcs-file-actions'
import { createGatingError, updateGatingError, removeGatingError } from '../gatekeeper-frontend/actions/gating-error-actions'
import { setSelectedWorkspace, updateWorkspace, selectFCSFile, invertPlotAxis, selectGateTemplate, setFCSDisabledParameters, setGatingHash,  setUnsavedGates, showGatingModal, hideGatingModal, setGatingModalErrorMessage } from '../gatekeeper-frontend/actions/workspace-actions'

import request from 'request'
let reduxStore

// Fork a new node process for doing CPU intensive jobs
let workerFork

const createFork = async function () {
    console.log('starting fork')
    const certsDirectory = path.join(remote.app.getPath('userData'), 'certs')
    try {
        fs.statSync(path.join(certsDirectory, 'localhost.key'))
        fs.statSync(path.join(certsDirectory, 'localhost.crt'))
    } catch (error) {
        console.log('generating local ssl certificate')
        await new Promise((resolve, reject) => {
            mkdirp(certsDirectory, function (error) {
                if (error) {
                    reject()
                } else {
                    resolve()
                }
            })
        })
        await createHttpsCertificate(certsDirectory)
    }

    if (isDev) {
        workerFork = fork(__dirname + '/gatekeeper-electron/subprocess-wrapper-dev.js', [ remote.app.getPath('userData') ], { silent: true })
    } else {
        workerFork = fork(__dirname + '/webpack-build/fork.bundle.js', [ remote.app.getPath('userData') ], { silent: true })
    }

    workerFork.stdout.on('data', async (result) => {
        if (reduxStore.getState().sessionLoading && !reduxStore.getState().sessionBroken) {
            await api.getSession()

            const action = {
                type: 'SET_SESSION_LOADING',
                payload: {
                    sessionLoading: false
                }
            }
            reduxStore.dispatch(action)

            const client = http2.connect('https://localhost:3146', {
              ca: fs.readFileSync(path.join(certsDirectory, 'localhost.crt'))
            });
            client.on('error', (err) => console.error(err));

            const req = client.request({ ':path': '/' });

            req.on('response', (headers, flags) => {
              for (const name in headers) {
                console.log(`${name}: ${headers[name]}`);
              }
            });

            req.setEncoding('utf8');
            let data = '';
            req.on('data', (chunk) => { data += chunk; });
            req.on('end', () => {
              // console.log(`\n${data}`);
              // client.close();
            });
            req.end();

            if (reduxStore.getState().selectedWorkspaceId) {
                const workspace = reduxStore.getState().workspaces.find(w => w.id === reduxStore.getState().selectedWorkspaceId)
                api.recalculateGateTemplateHeirarchy()
            }
        }
        console.log(result.toString('utf8'))
    })

    workerFork.stderr.on('data', (result) => {
        console.log(result.toString('utf8'))
    })

    workerFork.on('close', createFork);
    workerFork.on('error', createFork);
}

createFork()

const jobQueue = {}
const priorityQueue = {}

window.jobQueue = jobQueue
window.priorityQueue = priorityQueue

const pushToQueue = async function (job, priority) {
    let queueToPush = priority ? priorityQueue : jobQueue
    if (!queueToPush[job.jobKey]) {
        queueToPush[job.jobKey] = job
        return true
    } else {
        console.log("Job rejected as a duplicate is already in the queue, attaching callbacks other job")
        const callback = queueToPush[job.jobKey].callback
        const newCallback = (data) => {
            callback(data)
            if (job.checkValidity()) {
                job.callback(data)
            }
        }
        queueToPush[job.jobKey].callback = newCallback
        return false
    }
}

const processJob = async function () {
    if (!reduxStore || reduxStore.getState().sessionLoading) {
        return false
    }

    const priorityKeys = Object.keys(priorityQueue)
    const jobKeys = Object.keys(jobQueue)
    let currentJob
    let isPriority
    if (priorityKeys.length > 0) {
        currentJob = priorityQueue[priorityKeys[0]]
        delete priorityQueue[priorityKeys[0]]
        isPriority = true
    } else if (jobKeys.length > 0) {
        currentJob = jobQueue[jobKeys[0]]
        delete jobQueue[jobKeys[0]]
        isPriority = false
    }

    if (!currentJob) {
        return false
    } else if (!currentJob.checkValidity()) {
        return true
    } else if (!isPriority) {
        pushToQueue(currentJob, false)
        return false
    } else {
        let result
        let requestFunction = (resolve, reject) => {
            request.post(currentJob.jobParameters, function (error, response, body) {
                if (error) {
                    reject(error)
                }
                resolve(body)
            });
        }
        try {
            result = await new Promise(requestFunction)
        } catch (error) {
            console.log("Error in worker job, trying again")
            console.log(error)
            // Try a second time
            try {
                result = await new Promise(requestFunction)
            } catch (error) {
                console.log("error after two attempts")
                console.log(error)
            }
        }

        if (result) {
            currentJob.callback(result)
        }
    }
}

const processJobs = async function () {
    while (true) {
        const result = await processJob()
        if (result === false) {
            await new Promise((resolve, reject) => { setTimeout(() => { resolve() }, 100) })
        }
    }
}

for (let i = 0; i < Math.max(os.cpus().length - 2, 1); i++) {
    processJobs()
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

const writeFile = (path, data, opts = 'utf8') => {
    return new Promise((res, rej) => {
        fs.writeFile(path, data, opts, (err) => {
            if (err) rej(err)
            else res()
        })
    })
}

// Loops through the image directories on disk and deletes images that no longer reference a sample on disk
const cleanupImageDirectories = () => {
    for (var workspaceFile of ls(path.join(remote.app.getPath('userData'), 'workspaces', '*'))) {
        if (!reduxStore.getState().openWorkspaces.find(ws => ws.id === workspaceFile.file)) {
            console.log('going to delete workspace', workspaceFile.full)
            rimraf(workspaceFile.full, () => { console.log('deleted workspace', workspaceFile.full) })
        } else {
            for (var fcsFile of ls(path.join(remote.app.getPath('userData'), 'workspaces', workspaceFile.file, 'fcs-files', '*'))) {
                if (!reduxStore.getState().FCSFiles.find(fcs => fcs.id === fcsFile.file)) {
                    console.log('going to delete fcs file', fcsFile.full)
                    rimraf(fcsFile.full, () => { console.log('deleted fcs file', fcsFile.full) })
                }
            }
        }
    }
}

const getFCSMetadata = async (FCSFileId, fileName) => {
    const jobId = uuidv4()

    const metadata = await new Promise((resolve, reject) => {
        pushToQueue({
            jobParameters: { url: 'http://127.0.0.1:3145', json: { jobId: jobId, type: 'get-fcs-metadata', payload: { workspaceId: reduxStore.getState().selectedWorkspace.id, FCSFileId, fileName } } },
            jobKey: uuidv4(),
            checkValidity: () => { return true },
            callback: (data) => { resolve(data) }
        }, true)
    })

    return metadata
}

const sessionFilePath = path.join(remote.app.getPath('userData'), 'session.json')

let updateUnsavedGateTimeout

// -------------------------------------------------------------
// Exported functions below
// -------------------------------------------------------------

// Keep a copy of the redux store and dispatch events
export const setStore = (store) => { reduxStore = store }

// Write the whole session to the disk
export const saveSessionToDisk = async function () {
    // Save the new state to the disk
    fs.writeFile(sessionFilePath, JSON.stringify(reduxStore.getState()), () => {})
    if (reduxStore.getState().selectedWorkspace) {
        const workspaceDirectory = path.join(remote.app.getPath('userData'), 'workspaces', reduxStore.getState().selectedWorkspace.id)
        await new Promise((resolve, reject) => {
            mkdirp(workspaceDirectory, function (error) {
                if (error) {
                    reject()
                } else {
                    resolve()
                }
            })
        })
        fs.writeFile(path.join(workspaceDirectory, 'workspace.json'), JSON.stringify(reduxStore.getState().selectedWorkspace), (error) => {})
    }
}

// Load the workspaces and samples the user last had open when the app was used
export const api = {
    // Reset the session by deleting the session file off the disk
    resetSession: async function () {
        fs.unlinkSync(sessionFilePath)
        reduxStore.dispatch({ type: 'RESET_SESSION' })
        store.dispatch({ type: 'SET_API', payload: { api } })
        await api.getSession()
    },

    getSession: async function () {
        let currentState
        try {
            currentState = JSON.parse(await readFile(sessionFilePath))
        } catch (error) {
            // If there's no session file, create one
            if (error.code === 'ENOENT') {
                try {
                    const defaultState = reduxStore.getState()
                    writeFile(sessionFilePath, JSON.stringify(defaultState))
                    currentState = defaultState
                } catch (error) {
                    console.log(error)
                }
            } else {
                console.log(error)
            }
        }

        try {
            reduxStore.dispatch({ type: 'SET_SESSION_BROKEN', payload: { sessionBroken: false } })
            reduxStore.dispatch({ type: 'SET_SESSION_STATE', payload: currentState })
            cleanupImageDirectories()
        } catch (error) {
            reduxStore.dispatch({ type: 'SET_SESSION_BROKEN', payload: { sessionBroken: true } })
            console.log(error)
        }

        // After reading the session, if there's no workspace, create a default one
        if (reduxStore.getState().openWorkspaces.length === 0) {
            const workspaceId = await api.createWorkspace({ title: 'New Workspace', description: 'New Workspace' })
        }
    },

    setPlotDisplayDimensions: async function (plotWidth, plotHeight) {
        const action = setPlotDisplayDimensions(plotWidth, plotHeight)
        reduxStore.dispatch(action)

        await saveSessionToDisk()
    },

    toggleShowDisabledParameters: async function () {
        const action = toggleShowDisabledParameters()
        reduxStore.dispatch(action)
        window.dispatchEvent(new Event('resize'))

        await saveSessionToDisk()
    },

    createWorkspace: async function (parameters) {
        const workspaceId = uuidv4()

        const newWorkspace = {
            id: workspaceId,
            title: parameters.title,
            description: parameters.description,
            selectedXScale: parameters.selectedXScale || constants.SCALE_LOG,
            selectedYScale: parameters.selectedYScale || constants.SCALE_LOG,
            disabledParameters: {},
            hideUngatedPlots: false,
            invertedAxisPlots: {},
            filteredParameters: []
        }

        const addAction = addOpenWorkspace(newWorkspace)
        reduxStore.dispatch(addAction)

        const setAction = setSelectedWorkspace(newWorkspace)
        reduxStore.dispatch(setAction)

        // Add an empty Gate Template
        const gateTemplateId = uuidv4()
        const createGateTemplateAction = createGateTemplate({ id: gateTemplateId, title: 'New Gating Strategy' })
        reduxStore.dispatch(createGateTemplateAction)

        await api.selectGateTemplate(gateTemplateId, workspaceId)

        saveSessionToDisk()

        return newWorkspace.id
    },

    selectWorkspace: async function (workspaceId) {
        const workspaceData = JSON.parse(await readFile(path.join(remote.app.getPath('userData'), 'workspaces', workspaceId, 'workspace.json')))
        reduxStore.dispatch(setSelectedWorkspace(workspaceData))

        saveSessionToDisk()
    },

    // TODO: Select the closest workspace after removing it
    removeWorkspace: async function (workspaceId) {
        const removeAction = removeWorkspace(workspaceId)
        reduxStore.dispatch(removeAction)

        saveSessionToDisk()
    },

    // Update a gate template with arbitrary parameters
    updateGateTemplate: async function (gateTemplateId, parameters) {
        const gateTemplate = reduxStore.getState().gateTemplates.find(gt => gt.id === gateTemplateId)
        const updateAction = updateGateTemplate(gateTemplateId, parameters)
        reduxStore.dispatch(updateAction)

        saveSessionToDisk()
    },

    // Update a gate template with arbitrary parameters
    updateGateTemplateAndRecalculate: async function (gateTemplateId, parameters) {
        const gateTemplate = reduxStore.getState().gateTemplates.find(gt => gt.id === gateTemplateId)
        const updateAction = updateGateTemplate(gateTemplateId, parameters)
        reduxStore.dispatch(updateAction)

        // Update any child templates that depend on these
        if (gateTemplate.gateTemplateGroupId) {
            await api.recalculateGateTemplateGroup(gateTemplate.gateTemplateGroupId)
        }

        saveSessionToDisk()
    },

    selectGateTemplate: async function (gateTemplateId, workspaceId) {
        const selectAction = selectGateTemplate(gateTemplateId, workspaceId)
        reduxStore.dispatch(selectAction)

        saveSessionToDisk()
    },

    setGateTemplateExampleGate: function (gateTemplateId, exampleGateId) {
        const updateAction = updateGateTemplate(gateTemplateId, { exampleGateId })
        reduxStore.dispatch(updateAction)
    },

    removeGateTemplateGroup: async function (gateTemplateGroupId) {
        const removeAction = removeGateTemplateGroup(gateTemplateGroupId)

        reduxStore.dispatch(removeAction)

        saveSessionToDisk()
    },

    recalculateGateTemplateGroup: async function (gateTemplateGroupId) {
        let samplesToRecalculate = {}
        // Delete all child samples created as a result of this gate template group
        for (let sample of reduxStore.getState().samples.filter(s => reduxStore.getState().gateTemplates.find(gt => gt.id === s.gateTemplateId).gateTemplateGroupId === gateTemplateGroupId)) {
            samplesToRecalculate[sample.parentSampleId] = true
            const removeAction = removeSample(sample.id)
            reduxStore.dispatch(removeAction)
        }

        for (let sampleId of Object.keys(samplesToRecalculate)) {
             api.applyGateTemplatesToSample(sampleId)
        }
    },

    recalculateGateTemplateHeirarchy: async function () {
        // const missingCombinations = []
        // for (let FCSFile of reduxStore.getState().FCSFiles.filter(fcs => fcs.workspaceId === reduxStore.getState().selectedWorkspaceId)) {
        //     for (let gateTemplate of reduxStore.filter(fcs => fcs.workspaceId === reduxStore.getState().selectedWorkspaceId))
        // }
    },

    applyGateTemplatesToSample: async function (sampleId) {
        const sample = reduxStore.getState().samples.find(s => s.id === sampleId)
        const FCSFile = reduxStore.getState().FCSFiles.find(fcs => sample.FCSFileId === fcs.id)
        // Find all template groups that apply to this sample
        const templateGroups = reduxStore.getState().gateTemplateGroups.filter(g => g.parentGateTemplateId === sample.gateTemplateId)
        for (let templateGroup of templateGroups) {
            if (templateGroup.creator === constants.GATE_CREATOR_PERSISTENT_HOMOLOGY) {
                // If there hasn't been any gates generated for this sample, try generating them, otherwise leave them as they are
                if (!reduxStore.getState().samples.find(s => s.parentSampleId === sampleId && reduxStore.getState().gateTemplates.find(gt => gt.id === s.gateTemplateId).gateTemplateGroupId === templateGroup.id)
                    && !reduxStore.getState().gatingErrors.find(e => e.sampleId === sampleId && e.gateTemplateGroupId === templateGroup.id)) {
                    // Dispatch a redux action to mark the gate template as loading
                    let loadingMessage = 'Creating gates using Persistent Homology...'

                    let loadingAction = setSampleParametersLoading(sample.id, templateGroup.selectedXParameter + '_' + templateGroup.selectedYParameter, { loading: true, loadingMessage: loadingMessage})
                    reduxStore.dispatch(loadingAction)

                    const options = {
                        selectedXParameter: templateGroup.selectedXParameter,
                        selectedYParameter: templateGroup.selectedYParameter,
                        selectedXScale: templateGroup.selectedXScale,
                        selectedYScale: templateGroup.selectedYScale,
                        machineType: templateGroup.machineType,
                        minXValue: FCSFile.FCSParameters[templateGroup.selectedXParameter].statistics.positiveMin,
                        maxXValue: FCSFile.FCSParameters[templateGroup.selectedXParameter].statistics.max,
                        minYValue: FCSFile.FCSParameters[templateGroup.selectedYParameter].statistics.positiveMin,
                        maxYValue: FCSFile.FCSParameters[templateGroup.selectedYParameter].statistics.max,
                        plotWidth: reduxStore.getState().plotWidth,
                        plotHeight: reduxStore.getState().plotHeight
                    }

                    let homologyResult = await api.calculateHomology(sample.workspaceId, sample.FCSFileId, sample.id, options)

                    console.log(homologyResult)

                    if (homologyResult.status === constants.STATUS_SUCCESS) {
                        let gates = api.createGatePolygons(homologyResult.data.gates)
                        // Create the negative gate if there is one
                        const negativeGate = reduxStore.getState().gateTemplates.find(gt => gt.gateTemplateGroupId === templateGroup.id && gt.type === constants.GATE_TYPE_NEGATIVE)
                        if (negativeGate) {
                            const newGate = {
                                id: uuidv4(),
                                type: constants.GATE_TYPE_NEGATIVE,
                                title: FCSFile.FCSParameters[templateGroup.selectedXParameter].label + ' · ' + FCSFile.FCSParameters[templateGroup.selectedYParameter].label + ' Negative Gate',
                                sampleId: sampleId,
                                FCSFileId: FCSFile.id,
                                gateTemplateId: negativeGate.id,
                                selectedXParameter: templateGroup.selectedXParameter,
                                selectedYParameter: templateGroup.selectedYParameter,
                                selectedXScale: templateGroup.selectedXScale,
                                selectedYScale: templateGroup.selectedYScale,
                                gateCreator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                                gateCreatorData: {},
                                populationCount: 0
                            }

                            gates.push(newGate)
                        }

                        // Create the double zero gate if there is one
                        const doubleZeroGate = reduxStore.getState().gateTemplates.find(gt => gt.gateTemplateGroupId === templateGroup.id && gt.type === constants.GATE_TYPE_DOUBLE_ZERO)
                        if (doubleZeroGate) {
                            const newGate = {
                                id: uuidv4(),
                                type: constants.GATE_TYPE_DOUBLE_ZERO,
                                title: FCSFile.FCSParameters[templateGroup.selectedXParameter].label + ' · ' + FCSFile.FCSParameters[templateGroup.selectedYParameter].label + ' Double Zero Gate',
                                sampleId: sampleId,
                                FCSFileId: FCSFile.id,
                                gateTemplateId: doubleZeroGate.id,
                                selectedXParameter: templateGroup.selectedXParameter,
                                selectedYParameter: templateGroup.selectedYParameter,
                                selectedXScale: templateGroup.selectedXScale,
                                selectedYScale: templateGroup.selectedYScale,
                                gateCreator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                                gateCreatorData: {},
                                populationCount: 0
                            }

                            gates.push(newGate)
                        }

                        gates = await api.getGatePopulationCounts(gates)

                        // Create combo gates AFTER we know which events are in each smaller gate so that they can be concatted for combo gate contents
                        const comboGates = reduxStore.getState().gateTemplates.filter(gt => gt.gateTemplateGroupId === templateGroup.id && gt.type === constants.GATE_TYPE_COMBO)
                        for (let comboGate of comboGates) {
                            const includedGates = gates.filter(g => comboGate.typeSpecificData.gateTemplateIds.includes(g.gateTemplateId))

                            const newGate = {
                                id: uuidv4(),
                                type: constants.GATE_TYPE_COMBO,
                                title: FCSFile.FCSParameters[templateGroup.selectedXParameter].label + ' · ' + FCSFile.FCSParameters[templateGroup.selectedYParameter].label + ' Combo Gate',
                                sampleId: sampleId,
                                FCSFileId: FCSFile.id,
                                gateTemplateId: comboGate.id,
                                selectedXParameter: templateGroup.selectedXParameter,
                                selectedYParameter: templateGroup.selectedYParameter,
                                selectedXScale: templateGroup.selectedXScale,
                                selectedYScale: templateGroup.selectedYScale,
                                gateCreator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                                gateCreatorData: {
                                    gateIds: includedGates.map(g => g.id)
                                },
                                populationCount: includedGates.reduce((accumulator, current) => { return accumulator + current.populationCount }, 0)
                            }

                            gates.push(newGate)
                        }

                        if (gates.length > 0) {
                            for (let i = 0; i < gates.length; i++) {
                                const gate = gates[i]
                                // Delete any other gates or samples that may have been created in the interim
                                const matchingSample = reduxStore.getState().samples.find(s => s.gateTemplateId === gate.gateTemplateId && s.parentSampleId === sample.id)
                                if (matchingSample) {
                                    console.log('removing duplicate sample')
                                    const removeAction = removeSample(matchingSample.id)
                                    reduxStore.dispatch(removeAction)
                                }
                                gate.workspaceId = sample.workspaceId
                                await api.createSubSampleAndAddToWorkspace(
                                    sample.workspaceId,
                                    sampleId,
                                    {
                                        parentSampleId: sampleId,
                                        workspaceId: sample.workspaceId,
                                        FCSFileId: sample.FCSFileId,
                                        filePath: sample.filePath,
                                        title: gate.title,
                                        FCSParameters: FCSFile.FCSParameters,
                                        gateTemplateId: gate.gateTemplateId,
                                        selectedXParameter: templateGroup.selectedXParameter,
                                        selectedYParameter: templateGroup.selectedYParameter,
                                        selectedXScale: templateGroup.selectedXScale,
                                        selectedYScale: templateGroup.selectedYScale
                                    },
                                    gate,
                                )
                            }
                        }
                    } else if (homologyResult.status === constants.STATUS_FAIL) {
                        if (homologyResult.data) {
                            let gates = api.createGatePolygons(homologyResult.data.gates)
                            gates = await api.getGatePopulationCounts(gates)
                            // Remove any duplicate gating errors that may have been created at the same time
                            for (let gatingError of reduxStore.getState().gatingErrors.filter((e) => { return e.sampleId === sampleId && e.gateTemplateGroupId === templateGroup.id })) {
                                const removeGatingErrorAction = removeGatingError(gatingError.id)
                                reduxStore.dispatch(removeGatingErrorAction)
                            }

                            const gatingError = {
                                id: uuidv4(),
                                sampleId: sampleId,
                                gateTemplateGroupId: templateGroup.id,
                                gates: homologyResult.data.gates,
                                criteria:  homologyResult.data.criteria,
                            }
                            // Create a gating error
                            const createGatingErrorAction = createGatingError(gatingError)
                            reduxStore.dispatch(createGatingErrorAction)
                        }
                    }

                    saveSessionToDisk()

                    const loadingFinishedAction = setSampleParametersLoading(sample.id, templateGroup.selectedXParameter + '_' + templateGroup.selectedYParameter, { loading: false, loadingMessage: null })
                    reduxStore.dispatch(loadingFinishedAction)
                }
            }
        }

        // If homology was succesful, the sample will now have child samples
        for (let subSample of reduxStore.getState().samples.filter(s => s.parentSampleId === sampleId)) {
            await api.applyGateTemplatesToSample(subSample.id)
        }
    },

    createFCSFileAndAddToWorkspace: async function (FCSFileParameters) {
        const FCSFileId = uuidv4()

        let FCSFile = {
            id: FCSFileId,
            filePath: FCSFileParameters.filePath,
            title: FCSFileParameters.title,
            description: FCSFileParameters.description,
        }

        const createFCSFileAction = createFCSFile(FCSFile)
        reduxStore.dispatch(createFCSFileAction)

        const selectAction = selectFCSFile(FCSFileId)
        reduxStore.dispatch(selectAction)

        // Select the root gate when adding a new FCS file
        const selectGateTemplateAction = selectGateTemplate(reduxStore.getState().selectedWorkspace.gateTemplates.find(gt => !gt.parentGateTemplateId).id)
        reduxStore.dispatch(selectGateTemplateAction)

        // Import the fcs file
        await new Promise((resolve, reject) => {
            pushToQueue({
                jobParameters: { url: 'http://127.0.0.1:3145', json: { jobId: uuidv4(), type: 'import-fcs-file', payload: { workspaceId: reduxStore.getState().selectedWorkspace.id, FCSFileId, filePath: FCSFile.filePath } } },
                jobKey: uuidv4(),
                checkValidity: () => { return true },
                callback: (data) => { resolve(data) }
            }, true)
        })

        const FCSMetaData = await getFCSMetadata(FCSFileId, FCSFile.title)

        const updateAction = updateFCSFile(FCSFileId, FCSMetaData)
        reduxStore.dispatch(updateAction)

        const workspaceParameters = {
            selectedXScale: FCSMetaData.machineType === constants.MACHINE_CYTOF ? constants.SCALE_LOG : constants.SCALE_BIEXP,
            selectedYScale: FCSMetaData.machineType === constants.MACHINE_CYTOF ? constants.SCALE_LOG : constants.SCALE_BIEXP,
            selectedFCSFileId: FCSFileId
        }

        const updateWorkspaceAction = updateWorkspace(workspaceParameters)
        reduxStore.dispatch(updateWorkspaceAction)

        saveSessionToDisk()

        // Recursively apply the existing gating hierarchy
        api.recalculateGateTemplateHeirarchy()

        return FCSFileId
    },

    removeFCSFile: async function (FCSFileId) {
        const FCSFileIndex = reduxStore.getState().selectedWorkspace.FCSFiles.findIndex(fcs => fcs.id === FCSFileId)

        const removeAction = removeFCSFile(FCSFileId)
        reduxStore.dispatch(removeAction)

        if (reduxStore.getState().selectedWorkspace.FCSFiles.length > 0) {
            const newIndex = Math.min(Math.max(FCSFileIndex, 0), reduxStore.getState().selectedWorkspace.FCSFiles.length - 1)
            const selectAction = selectFCSFile(reduxStore.getState().selectedWorkspace.FCSFiles[newIndex].id)
            reduxStore.dispatch(selectAction)
        }

        saveSessionToDisk()
    },

    createSubSampleAndAddToWorkspace: async function (workspaceId, parentSampleId, sampleParameters, gateParameters) {
        const sampleId = sampleParameters.id || uuidv4()
        const gateId = gateParameters.id || uuidv4()

        // Find the associated workspace
        let workspace = reduxStore.getState().workspaces.find(w => w.id === workspaceId)

        const parentSample = reduxStore.getState().samples.find(s => s.id === parentSampleId)
        const FCSFile = reduxStore.getState().FCSFiles.find(fcs => fcs.id === parentSample.FCSFileId)

        let sample = {
            id: sampleId,
            parentSampleId: sampleParameters.parentSampleId,
            FCSFileId: parentSample.FCSFileId,
            workspaceId: sampleParameters.workspaceId,
            title: sampleParameters.title,
            description: sampleParameters.description,
            gateTemplateId: sampleParameters.gateTemplateId,
            parametersLoading: [],
        }

        const options = {
            selectedXParameterIndex: FCSFile.FCSParameters[gateParameters.selectedXParameter].index,
            selectedYParameterIndex: FCSFile.FCSParameters[gateParameters.selectedYParameter].index,
            selectedXScale: gateParameters.selectedXScale,
            selectedYScale: gateParameters.selectedYScale,
            machineType: FCSFile.machineType,
            minXValue: FCSFile.FCSParameters[gateParameters.selectedXParameter].statistics.positiveMin,
            maxXValue: FCSFile.FCSParameters[gateParameters.selectedXParameter].statistics.max,
            minYValue: FCSFile.FCSParameters[gateParameters.selectedYParameter].statistics.positiveMin,
            maxYValue: FCSFile.FCSParameters[gateParameters.selectedYParameter].statistics.max,
            plotWidth: reduxStore.getState().plotWidth,
            plotHeight: reduxStore.getState().plotHeight
        }
        // Before creating the new subsample, save the included event ids to the disk to use later
        let result = await new Promise((resolve, reject) => {
            pushToQueue({
                jobParameters: { url: 'http://127.0.0.1:3145', json: { type: 'save-new-subsample', payload: { workspaceId: sample.workspaceId, FCSFileId: sample.FCSFileId, parentSampleId, childSampleId: sampleId, gate: gateParameters, populationCount: gateParameters.populationCount, options } } },
                jobKey: uuidv4(),
                checkValidity: () => { return true },
                callback: (data) => { resolve(data) }
            }, true)
        })

        gateParameters.id = gateId
        gateParameters.childSampleId = sampleId
        gateParameters.parentSampleId = sampleParameters.parentSampleId

        // If there was no title specified, auto generate one
        let title = 'Subsample'

        reduxStore.dispatch(createSample(sample))
        reduxStore.dispatch(createGate(gateParameters))

        // If the gate template doesn't have an example gate yet, use this one
        const gateTemplate = reduxStore.getState().gateTemplates.find(gt => gt.id === gateParameters.gateTemplateId)
        if (!gateTemplate.exampleGateId) {
            await api.setGateTemplateExampleGate(gateTemplate.id, gateId)
        }

        const updatedSample = reduxStore.getState().samples.find(s => s.id === sample.id)

        saveSessionToDisk()
    },

    createPopulationFromGates: async function (workspaceId, FCSFile, gateTemplates) {
        const gates = reduxStore.getState().gates.filter(g => g.FCSFileId === FCSFile.id && gateTemplates.map(gt => gt.id).includes(g.gateTemplateId))
        const options = {
            machineType: FCSFile.machineType,
            plotWidth: reduxStore.getState().plotWidth,
            plotHeight: reduxStore.getState().plotHeight
        }
        // Before creating the new subsample, save the included event ids to the disk to use later
        let result = await new Promise((resolve, reject) => {
            pushToQueue({
                jobParameters: { url: 'http://127.0.0.1:3145', json: { type: 'create-population-from-gates', payload: { workspaceId, FCSFile: FCSFile, gates, options } } },
                jobKey: uuidv4(),
                checkValidity: () => { return true },
                callback: (data) => { resolve(data) }
            }, true)
        })

        reduxStore.dispatch(setGatingHash(workspaceId, md5(gates.map(g => g.id).sort().join('-'))))
    },

    removeSample: async function (sampleId) {
        const removeAction = removeSample(sampleId)

        reduxStore.dispatch(removeAction)

        saveSessionToDisk()
    },

    savePopulationAsCSV: function (FCSFileId, gateTemplateId) {
        const gateTemplate = reduxStore.getState().selectedWorkspace.gateTemplates.find(gt => gt.id === gateTemplateId)
        dialog.showSaveDialog({ title: `Save Population as CSV`, message: `Save Population as CSV`, defaultPath: `${gateTemplate.title}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] }, (filePath) => {
            if (filePath) {
                new Promise((resolve, reject) => {
                    pushToQueue({
                        jobParameters: { url: 'http://127.0.0.1:3145', json: { type: 'save-population-as-csv', payload: { workspaceId: reduxStore.getState().selectedWorkspace.id, FCSFileId, gateTemplateId, filePath } } },
                        jobKey: uuidv4(),
                        checkValidity: () => { return true },
                        callback: (data) => { resolve(data) }
                    }, true)
                })
            }
        })
    },

    selectFCSFile: async function (FCSFileId) {
        const selectAction = selectFCSFile(FCSFileId)
        reduxStore.dispatch(selectAction)

        saveSessionToDisk()
    },

    // Update an FCSFile with arbitrary parameters
    updateFCSFile: async function (FCSFileId, parameters) {
        const updateAction = updateFCSFile(FCSFileId, parameters)
        reduxStore.dispatch(updateAction)

        saveSessionToDisk()

        // If the machine type was updated, recalculate gates and images
        if (parameters.machineType) {
            const workspaceParameters = {
                selectedXScale: parameters.machineType === constants.MACHINE_CYTOF ? constants.SCALE_LOG : constants.SCALE_BIEXP,
                selectedYScale: parameters.machineType === constants.MACHINE_CYTOF ? constants.SCALE_LOG : constants.SCALE_BIEXP
            }

            await api.updateWorkspace(workspaceParameters)

            // for (let sample of reduxStore.getState().samples) {
            //     api.applyGateTemplatesToSample(sample.id)
            // }
        }
    },

    // Update a workspace with arbitrary parameters
    updateWorkspace: async function (workspaceId, parameters) {
        const updateWorkspaceAction = updateWorkspace(workspaceId, parameters)
        reduxStore.dispatch(updateWorkspaceAction)

        saveSessionToDisk()
    },

    // Toggle inversion of parameters for display of a particular plot
    invertPlotAxis: async function (workspaceId, selectedXParameter, selectedYParameter) {
        const updateWorkspaceAction = invertPlotAxis(workspaceId, selectedXParameter, selectedYParameter)
        reduxStore.dispatch(updateWorkspaceAction)

        saveSessionToDisk()
    },

    setFCSDisabledParameters: async function (parameters) {
        const setAction = setFCSDisabledParameters(parameters)
        reduxStore.dispatch(setAction)

        saveSessionToDisk()
    },

    createUnsavedGatesUsingHomology: async function (workspaceId, FCSFileId, gateTemplateId, options) {
        // Dispatch a redux action to mark the gate template as loading
        let homologyResult = await api.calculateHomology(workspaceId, FCSFileId, gateTemplateId, options)

        if (homologyResult.status === constants.STATUS_SUCCESS) {
            const gates = api.createGatePolygons(homologyResult.data.gates)
            const setUnsavedGatesAction = setUnsavedGates(gates)
            reduxStore.dispatch(setUnsavedGatesAction)

            await api.updateUnsavedGateDerivedData()
        } else {
            const createErrorAction = setGatingModalErrorMessage(homologyResult.error)
            reduxStore.dispatch(createErrorAction)
        }
    },

    resetUnsavedGates () {
        const setUnsavedGatesAction = setUnsavedGates(null)
        reduxStore.dispatch(setUnsavedGatesAction)
    },

    // Performs persistent homology calculation to automatically create gates on a sample
    // If a related gateTemplate already exists it will be applied, otherwise a new one will be created.
    // Options shape:
    //    {
    //        selectedXParameter,
    //        selectedYParameter,
    //        selectedXScale,
    //        selectedYScale,
    //        machineType
    //    }
    calculateHomology: async function (FCSFileId, gateTemplateId, options) {
        const FCSFile = reduxStore.getState().selectedWorkspace.FCSFiles.find(fcs => fcs.id === FCSFileId)

        let gateTemplate = reduxStore.getState().selectedWorkspace.gateTemplates.find(gt => gt.id === gateTemplateId)
        let gateTemplateGroup = reduxStore.getState().selectedWorkspace.gateTemplateGroups.find((group) => {
            return group.parentGateTemplateId === gateTemplateId
                && group.selectedXParameter === options.selectedXParameter
                && group.selectedYParameter === options.selectedYParameter
                && group.selectedXScale === options.selectedXScale
                && group.selectedYScale === options.selectedYScale
                && group.machineType === FCSFile.machineType
        })

        let homologyOptions = { workspaceId: reduxStore.getState().selectedWorkspace.id, FCSFileId, gateTemplateId, options }

        homologyOptions.options.plotWidth = reduxStore.getState().plotWidth
        homologyOptions.options.plotHeight = reduxStore.getState().plotHeight
        homologyOptions.options.selectedXParameterIndex = FCSFile.FCSParameters[options.selectedXParameter].index
        homologyOptions.options.selectedYParameterIndex = FCSFile.FCSParameters[options.selectedYParameter].index

        if (options.seedPeaks) {
            homologyOptions.options.seedPeaks = options.seedPeaks
        }

        // If there are already gating templates defined for this parameter combination
        if (gateTemplateGroup) {
            const gateTemplates = reduxStore.getState().selectedWorkspace.gateTemplates.filter(gt => gt.gateTemplateGroupId === gateTemplateGroup.id)
            homologyOptions.options = Object.assign({}, homologyOptions.options, gateTemplateGroup.typeSpecificData)
            homologyOptions.gateTemplates = gateTemplates.map(g => Object.assign({}, g))
        }

        // const intervalToken = setInterval(() => {
        //     loadingAction = setSampleParametersLoading(gateTemplateId, options.selectedXParameter + '_' + options.selectedYParameter, { loading: true, loadingMessage: 'update'})
        //     reduxStore.dispatch(loadingAction)
        // }, 500)

        let postBody

        if (gateTemplateGroup) {
            postBody = { type: 'find-peaks-with-template', payload: homologyOptions }
        } else {
            postBody = { type: 'find-peaks', payload: homologyOptions }
        }

        const checkValidity = () => {
            const gateTemplate = reduxStore.getState().selectedWorkspace.gateTemplates.find(gt => gt.id === gateTemplateId)
            // If the gateTemplate or gate template group has been deleted while homology has been calculating, just do nothing
            if (!gateTemplate || (gateTemplateGroup && !reduxStore.getState().selectedWorkspace.gateTemplateGroups.find((group) => {
                return group.parentGateTemplateId === gateTemplateId
                    && group.selectedXParameter === options.selectedXParameter
                    && group.selectedYParameter === options.selectedYParameter
                    && group.selectedXScale === options.selectedXScale
                    && group.selectedYScale === options.selectedYScale
                    && group.machineType === FCSFile.machineType
            }))) { return false }

            return true
        }

        const homologyResult = await new Promise((resolve, reject) => {
            pushToQueue({
                jobParameters: { url: 'http://127.0.0.1:3145', json: Object.assign({}, postBody, { jobId: uuidv4() }) },
                jobKey: uuidv4(),
                checkValidity,
                callback: (data) => { resolve(data) }
            }, true)
        })

        if (!checkValidity()) {
            return {
                status: constants.STATUS_FAIL,
                message: 'Error calculating homology, gate template or gate template group has been deleted'
            }
        }

        // If it was a real error (i.e. a caught programmatic error) return the result
        if (homologyResult.status === constants.STATUS_FAIL && !homologyResult.data) {
            return homologyResult
        }

        // clearInterval(intervalToken)
        let gates = []

        for (let i = 0; i < homologyResult.data.gates.length; i++) {
            const peak = homologyResult.data.gates[i]

            let gate

            if (peak.type === constants.GATE_TYPE_POLYGON) {
                gate = {
                    id: uuidv4(),
                    type: constants.GATE_TYPE_POLYGON,
                    title: FCSFile.FCSParameters[options.selectedXParameter].label + (peak.xGroup == 0 ? ' (LOW) · ' : ' (HIGH) · ') + FCSFile.FCSParameters[options.selectedYParameter].label + (peak.yGroup == 1 ? ' (LOW)' : ' (HIGH)'),
                    gateData: {
                        polygons: peak.polygons,
                        nucleus: peak.nucleus
                    },
                    xGroup: peak.xGroup,
                    yGroup: peak.yGroup,
                    FCSFileId: FCSFile.id,
                    gateTemplateId: peak.gateTemplateId || gateTemplateId,
                    populationCount: 0,
                    selectedXParameter: options.selectedXParameter,
                    selectedYParameter: options.selectedYParameter,
                    selectedXScale: options.selectedXScale,
                    selectedYScale: options.selectedYScale,
                    gateCreator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                    gateCreatorData: peak.gateCreatorData,
                }
            }

            gates.push(gate)
        }

        homologyOptions.gates = gates

        // Expand gates to include zero value data
        if (FCSFile.machineType === constants.MACHINE_CYTOF) {
            gates = await new Promise((resolve, reject) => {
                pushToQueue({
                    jobParameters: { url: 'http://127.0.0.1:3145', json: { type: 'get-expanded-gates', payload: homologyOptions } },
                    jobKey: uuidv4(),
                    checkValidity,
                    callback: (data) => { resolve(data) }
                }, true)
            })
        }

        homologyResult.data.gates = gates

        return homologyResult
    },

    showGatingModal (selectedXParameter, selectedYParameter) {
        const showGatingModalAction = showGatingModal(selectedXParameter, selectedYParameter)
        reduxStore.dispatch(showGatingModalAction)

        if (reduxStore.getState().selectedWorkspace.unsavedGates && reduxStore.getState().selectedWorkspace.unsavedGates.length > 0) {
            api.updateUnsavedGateDerivedData()
        }
    },

    hideGatingModal () {
        const hideGatingModalAction = hideGatingModal()
        reduxStore.dispatch(hideGatingModalAction)
    },

    createGatePolygons (gates) {
        const CYTOF_HISTOGRAM_WIDTH = Math.round(Math.min(reduxStore.getState().plotWidth, reduxStore.getState().plotHeight) * 0.07)
        const maxYValue = reduxStore.getState().plotHeight - CYTOF_HISTOGRAM_WIDTH

        const filteredGates = gates.filter(g => g.type === constants.GATE_TYPE_POLYGON)
        filteredGates.map((gate) => { gate.renderedPolygon = breakLongLinesIntoPoints(gate.gateData.polygons[gate.gateCreatorData.truePeakWidthIndex + gate.gateCreatorData.widthIndex]) })
        const overlapFixed = fixOverlappingPolygonsUsingZipper(filteredGates.map(g => g.renderedPolygon))
        for (let i = 0; i < filteredGates.length; i++) {
            filteredGates[i].renderedPolygon = overlapFixed[i]
            filteredGates[i].renderedXCutoffs = []
            filteredGates[i].renderedYCutoffs = []
        }

        const yExpanded = filteredGates.filter(g => g.type === constants.GATE_TYPE_POLYGON && g.gateCreatorData.includeYChannelZeroes).sort((a, b) => { return a.gateData.nucleus[0] - b.gateData.nucleus[0] })
        for (let i = 0; i < yExpanded.length; i++) {
            const gate = yExpanded[i]
            const xBoundaries = getPolygonBoundaries(gate.gateData.polygons[gate.gateCreatorData.truePeakWidthIndex + gate.gateCreatorData.widthIndex])[0]

            for (let j = i + 1; j < yExpanded.length; j++) {
                const gate2 = yExpanded[j]
                const xBoundaries2 = getPolygonBoundaries(gate2.gateData.polygons[gate2.gateCreatorData.truePeakWidthIndex + gate2.gateCreatorData.widthIndex])[0]

                if (xBoundaries[1][0] > xBoundaries2[0][0]) {
                    gate.renderedYCutoffs[1] = Math.round((xBoundaries[1][0] + xBoundaries2[0][0]) / 2) - 1
                    gate2.renderedYCutoffs[0] = Math.round((xBoundaries[1][0] + xBoundaries2[0][0]) / 2) + 1
                }
            }

            if (!gate.renderedYCutoffs[0]) {
                gate.renderedYCutoffs[0] = xBoundaries[0][0]
            }

            if (!gate.renderedYCutoffs[1]) {
                gate.renderedYCutoffs[1] = xBoundaries[1][0]
            }

            // Find the most appropriate point to connect x axis cutoffs to so that the peak doesn't overlap nearby peaks
            // 0 and 1 correspond to the minimum and maximum cutoffs on the axis
            let closestDistance0 = Infinity
            let closestIndex0

            let closestDistance1 = Infinity
            let closestIndex1
            for (let j = 0; j < gate.renderedPolygon.length; j++) {
                const point = gate.renderedPolygon[j]
                if (Math.abs(point[0] - gate.renderedYCutoffs[0]) < closestDistance0) {
                    let intersect = false
                    for (let g of filteredGates) {
                        if (g.id !== gate.id) {
                            intersect = intersect || polygonsIntersect(g.renderedPolygon, [[gate.renderedYCutoffs[0], maxYValue], point, [gate.renderedYCutoffs[0], maxYValue]])
                        }
                    }

                    if (!intersect) {
                        closestDistance0 = Math.abs(point[0] - gate.renderedYCutoffs[0])
                        closestIndex0 = j
                    }
                }

                if (Math.abs(point[0] - gate.renderedYCutoffs[1]) < closestDistance1) {
                    let intersect = false
                    for (let g of filteredGates) {
                        if (g.id !== gate.id) {
                            intersect = intersect || polygonsIntersect(g.renderedPolygon, [[gate.renderedYCutoffs[1], maxYValue], point, [gate.renderedYCutoffs[1], maxYValue]])
                        }
                    }

                    if (!intersect) {
                        closestDistance1 = Math.abs(point[0] - gate.renderedYCutoffs[1])
                        closestIndex1 = j
                    }
                }
            }

            // If we couldn't find any closest index that doesn't cause an intersection, just use the closest point on the polygon
            if (!closestIndex0) {
                for (let j = 0; j < gate.renderedPolygon.length; j++) {
                    const point = gate.renderedPolygon[j]

                    if (distanceBetweenPoints(point, [gate.renderedYCutoffs[0], maxYValue]) < closestDistance0) {
                        closestDistance0 = Math.round(distanceBetweenPoints(point, [gate.renderedYCutoffs[0], maxYValue]))
                        closestIndex0 = j
                    }
                }
            }

            if (!closestIndex1) {
                for (let j = 0; j < gate.renderedPolygon.length; j++) {
                    const point = gate.renderedPolygon[j]

                    if (distanceBetweenPoints(point, [gate.renderedYCutoffs[1], maxYValue]) < closestDistance1) {
                        closestDistance1 = Math.round(distanceBetweenPoints(point, [gate.renderedYCutoffs[1], maxYValue]))
                        closestIndex1 = j
                    }
                }
            }

            let newPolygon = []
            let shouldAdd = true
            for (let j = 0; j < gate.renderedPolygon.length; j++) {
                const point = gate.renderedPolygon[j]
                if (shouldAdd) {
                    newPolygon.push(point)
                }
                if (j === closestIndex1) {
                    // Insert the new 0 edge points
                    if (gate.gateCreatorData.includeXChannelZeroes) {
                        newPolygon = newPolygon.concat([
                            [gate.renderedYCutoffs[1], maxYValue],
                            [0, maxYValue]
                        ])
                        gate.renderedYCutoffs[0] = 0
                    } else {
                        newPolygon = newPolygon.concat([
                            [gate.renderedYCutoffs[1], maxYValue],
                            [gate.renderedYCutoffs[0], maxYValue]
                        ])
                    }
                    shouldAdd = false
                } else if (j === closestIndex0) {
                    shouldAdd = true
                }
            }

            newPolygon = breakLongLinesIntoPoints(newPolygon)
            // Recalculate the polygon boundary
            gate.renderedPolygon = hull(newPolygon, 50)
        }

        const xExpanded = filteredGates.filter(g => g.type === constants.GATE_TYPE_POLYGON && g.gateCreatorData.includeXChannelZeroes).sort((a, b) => { return a.gateData.nucleus[1] - b.gateData.nucleus[1] })
        for (let i = 0; i < xExpanded.length; i++) {
            const gate = xExpanded[i]
            const yBoundaries = getPolygonBoundaries(gate.gateData.polygons[gate.gateCreatorData.truePeakWidthIndex + gate.gateCreatorData.widthIndex])[1]

            for (let j = i + 1; j < xExpanded.length; j++) {
                const gate2 = xExpanded[j]
                const yBoundaries2 = getPolygonBoundaries(gate2.gateData.polygons[gate2.gateCreatorData.truePeakWidthIndex + gate2.gateCreatorData.widthIndex])[1]

                if (yBoundaries[1][1] > yBoundaries2[0][1]) {
                    gate.renderedXCutoffs[1] = Math.round((yBoundaries[1][1] + yBoundaries2[0][1]) / 2) - 1
                    gate2.renderedXCutoffs[0] = Math.round((yBoundaries[1][1] + yBoundaries2[0][1]) / 2) + 1
                }
            }

            if (!gate.renderedXCutoffs[0]) {
                gate.renderedXCutoffs[0] = yBoundaries[0][1]
            }

            if (!gate.renderedXCutoffs[1]) {
                gate.renderedXCutoffs[1] = yBoundaries[1][1]
            }

            // Find the most appropriate point to connect x axis cutoffs to so that the peak doesn't overlap nearby peaks
            // 0 and 1 correspond to the minimum and maximum cutoffs on the axis
            let closestDistance0 = Infinity
            let closestIndex0

            let closestDistance1 = Infinity
            let closestIndex1
            for (let j = 0; j < gate.renderedPolygon.length; j++) {
                const point = gate.renderedPolygon[j]
                if (Math.abs(point[1] - gate.renderedXCutoffs[0]) < closestDistance0) {
                    let intersect = false
                    for (let g of filteredGates) {
                        if (g.id !== gate.id) {
                            intersect = intersect || polygonsIntersect(g.renderedPolygon, [[0, gate.renderedXCutoffs[0]], point, [0, gate.renderedXCutoffs[0]]])
                        }
                    }

                    if (!intersect) {
                        closestDistance0 = Math.abs(point[1] - gate.renderedXCutoffs[0])
                        closestIndex0 = j
                    }
                }

                if (Math.abs(point[1] - gate.renderedXCutoffs[1]) < closestDistance1) {
                    let intersect = false
                    for (let g of filteredGates) {
                        if (g.id !== gate.id) {
                            intersect = intersect || polygonsIntersect(g.renderedPolygon, [[0, gate.renderedXCutoffs[1]], point, [0, gate.renderedXCutoffs[1]]])
                        }
                    }

                    if (!intersect) {
                        closestDistance1 = Math.abs(point[1] - gate.renderedXCutoffs[1])
                        closestIndex1 = j
                    }
                }
            }

            // If we couldn't find any closest index that doesn't cause an intersection, just use the closest point on the polygon
            if (!closestIndex0) {
                for (let j = 0; j < gate.renderedPolygon.length; j++) {
                    const point = gate.renderedPolygon[j]

                    if (distanceBetweenPoints(point, [0, gate.renderedXCutoffs[0]]) < closestDistance0) {
                        closestDistance0 = Math.round(distanceBetweenPoints(point, [0, gate.renderedXCutoffs[0]]))
                        closestIndex0 = j
                    }
                }
            }

            if (!closestIndex1) {
                for (let j = 0; j < gate.renderedPolygon.length; j++) {
                    const point = gate.renderedPolygon[j]

                    if (distanceBetweenPoints(point, [0, gate.renderedXCutoffs[1]]) < closestDistance1) {
                        closestDistance1 = Math.round(distanceBetweenPoints(point, [0, gate.renderedXCutoffs[1]]))
                        closestIndex1 = j
                    }
                }
            }

            let newPolygon = []
            let shouldAdd = true
            for (let j = 0; j < gate.renderedPolygon.length; j++) {
                const point = gate.renderedPolygon[j]
                if (shouldAdd) {
                    newPolygon.push(point)
                }
                if ((!gate.gateCreatorData.includeYChannelZeroes && j === closestIndex1) || (gate.gateCreatorData.includeYChannelZeroes && point[0] === 0 && point[1] === maxYValue)) {
                    // Insert the new 0 edge points
                    if (gate.gateCreatorData.includeYChannelZeroes) {
                        newPolygon = newPolygon.concat([
                            [0, maxYValue],
                            [0, gate.renderedXCutoffs[0]]
                        ])
                        gate.renderedXCutoffs[1] = maxYValue
                    } else {
                        newPolygon = newPolygon.concat([
                            [0, gate.renderedXCutoffs[1]],
                            [0, gate.renderedXCutoffs[0]]
                        ])
                    }

                    shouldAdd = false
                } else if (j === closestIndex0) {
                    shouldAdd = true
                }
            }

            newPolygon = breakLongLinesIntoPoints(newPolygon)
            // Recalculate the polygon boundary

            gate.renderedPolygon = hull(newPolygon, 50)
        }

        return filteredGates.concat(gates.filter(g => g.type !== constants.GATE_TYPE_POLYGON))
    },

    getGatePopulationCounts: async function (gates) {
        const FCSFile = reduxStore.getState().selectedWorkspace.FCSFiles.find(fcs => fcs.id === gates[0].FCSFileId)

        const options = {
            selectedXParameterIndex: FCSFile.FCSParameters[gates[0].selectedXParameter].index,
            selectedYParameterIndex: FCSFile.FCSParameters[gates[0].selectedYParameter].index,
            selectedXScale: gates[0].selectedXScale,
            selectedYScale: gates[0].selectedYScale,
            machineType: FCSFile.machineType,
            minXValue: FCSFile.FCSParameters[gates[0].selectedXParameter].statistics.positiveMin,
            maxXValue: FCSFile.FCSParameters[gates[0].selectedXParameter].statistics.max,
            minYValue: FCSFile.FCSParameters[gates[0].selectedYParameter].statistics.positiveMin,
            maxYValue: FCSFile.FCSParameters[gates[0].selectedYParameter].statistics.max,
            plotWidth: reduxStore.getState().plotWidth,
            plotHeight: reduxStore.getState().plotHeight
        }

        let newUnsavedGates = await new Promise((resolve, reject) => {
            pushToQueue({
                jobParameters: { url: 'http://127.0.0.1:3145', json: { type: 'get-gate-population-counts', payload: { workspaceId: reduxStore.getState().selectedWorkspace.id, FCSFileId: FCSFile.id, gateTemplateId: gates[0].gateTemplateId, gates, options } } },
                jobKey: uuidv4(),
                checkValidity: () => { return true },
                callback: (data) => { resolve(data) }
            }, true)
        })

        return newUnsavedGates
    },

    updateUnsavedGateDerivedData: async function () {
        const saveGates = (gates) => {
            const setUnsavedGatesAction = setUnsavedGates(gates)
            reduxStore.dispatch(setUnsavedGatesAction)
        }

        const toSave = api.createGatePolygons(reduxStore.getState().selectedWorkspace.unsavedGates)
        saveGates(toSave)

        await api.getGatePopulationCounts(reduxStore.getState().selectedWorkspace.unsavedGates).then((newUnsavedGates) => {
            if (!reduxStore.getState().selectedWorkspace.unsavedGates) {
                return
            }

            const toSave = newUnsavedGates.map((gate) => {
                const updatedGate = reduxStore.getState().selectedWorkspace.unsavedGates.find(g => g.id === gate.id)
                updatedGate.populationCount = gate.populationCount
                return updatedGate
            })

            // Update event counts on combo gates
            for (let gate of toSave) {
                if (gate.type === constants.GATE_TYPE_COMBO) {
                    const includedGates = reduxStore.getState().selectedWorkspace.unsavedGates.filter(g => gate.gateCreatorData.gateIds.includes(g.id))
                    gate.populationCount = includedGates.reduce((accumulator, current) => { return accumulator + current.populationCount }, [])
                }
            }

            saveGates(toSave)
        })
    },

    updateUnsavedGate: async function (gateId, parameters) {
        const gateIndex = reduxStore.getState().unsavedGates.findIndex(g => g.id === gateId)
        if (gateIndex > -1) {
            const newGate = merge(reduxStore.getState().unsavedGates[gateIndex], parameters)
            newGate.gateCreatorData.widthIndex = Math.max(Math.min(newGate.gateCreatorData.widthIndex, newGate.gateData.polygons.length - 1 - newGate.gateCreatorData.truePeakWidthIndex), - newGate.gateCreatorData.truePeakWidthIndex)
            const newUnsavedGates = api.createGatePolygons(reduxStore.getState().unsavedGates.slice(0, gateIndex).concat(newGate).concat(reduxStore.getState().unsavedGates.slice(gateIndex + 1)))
            const setUnsavedGatesAction = setUnsavedGates(newUnsavedGates)
            reduxStore.dispatch(setUnsavedGatesAction)

            if (updateUnsavedGateTimeout) {
                clearTimeout(updateUnsavedGateTimeout)
            }

            updateUnsavedGateTimeout = setTimeout(() => {
                api.updateUnsavedGateDerivedData()
            }, 500)
        } else {
            console.log('Error in updateUnsavedGate: no gate with id ', gateId, 'was found.')
        }
    },

    removeUnsavedGate (gateId) {
        const gateIndex = reduxStore.getState().unsavedGates.findIndex(g => g.id === gateId)
        if (gateIndex > -1) {
            const newUnsavedGates = reduxStore.getState().unsavedGates.slice(0, gateIndex).concat(reduxStore.getState().unsavedGates.slice(gateIndex + 1))
            const polyGates = newUnsavedGates.filter(g => g.type === constants.GATE_TYPE_POLYGON)
            const axisGroups = getAxisGroups(polyGates.map((g) => { return { id: g.id, nucleus: g.gateData.nucleus } }))
            for (let gate of polyGates) {
                gate.xGroup = axisGroups.xGroups.findIndex(g => g.peaks.includes(gate.id))
                gate.yGroup = axisGroups.yGroups.findIndex(g => g.peaks.includes(gate.id))

                const template = reduxStore.getState().gateTemplates.find(gt => gt.xGroup === gate.xGroup && gt.yGroup === gate.yGroup)
                if (template) {
                    gate.gateTemplateId = template.id
                }
            }
            const setUnsavedGatesAction = setUnsavedGates(newUnsavedGates)
            reduxStore.dispatch(setUnsavedGatesAction)
        } else {
            console.log('Error in updateUnsavedGate: no gate with id ', gateId, 'was found.')
        }
    },

    setUnsavedNegativeGateVisible (visible) {
        if (visible) {
            const firstGate = reduxStore.getState().unsavedGates.slice(0, 1)[0]
            const FCSFile = reduxStore.getState().FCSFiles.find(fcs => fcs.id === firstGate.FCSFileId)
            const newGate = {
                id: uuidv4(),
                type: constants.GATE_TYPE_NEGATIVE,
                title: FCSFile.FCSParameters[firstGate.selectedXParameter].label + ' · ' + FCSFile.FCSParameters[firstGate.selectedYParameter].label + ' Negative Gate',
                sampleId: firstGate.sampleId,
                FCSFileId: firstGate.FCSFileId,
                selectedXParameter: firstGate.selectedXParameter,
                selectedYParameter: firstGate.selectedYParameter,
                selectedXScale: firstGate.selectedXScale,
                selectedYScale: firstGate.selectedYScale,
                gateCreator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                gateCreatorData: {},
                populationCount: 0
            }
            const newUnsavedGates = reduxStore.getState().unsavedGates.concat([newGate])
            const setUnsavedGatesAction = setUnsavedGates(newUnsavedGates)
            reduxStore.dispatch(setUnsavedGatesAction)

            api.updateUnsavedGateDerivedData()
        } else {
            const gateIndex = reduxStore.getState().unsavedGates.findIndex(g => g.type === constants.GATE_TYPE_NEGATIVE)
            if (gateIndex > -1) {
                const newUnsavedGates = reduxStore.getState().unsavedGates.slice(0, gateIndex).concat(reduxStore.getState().unsavedGates.slice(gateIndex + 1))
                const setUnsavedGatesAction = setUnsavedGates(newUnsavedGates)
                reduxStore.dispatch(setUnsavedGatesAction)
            } else {
                console.log('Error trying to toggle negative unsaved gate, no negative gate was found.')
            }
        }
    },

    setUnsavedDoubleZeroGateVisible (visible) {
        if (visible) {
            const firstGate = reduxStore.getState().unsavedGates.slice(0, 1)[0]
            const FCSFile = reduxStore.getState().FCSFiles.find(fcs => fcs.id === firstGate.FCSFileId)
            const newGate = {
                id: uuidv4(),
                type: constants.GATE_TYPE_DOUBLE_ZERO,
                title: FCSFile.FCSParameters[firstGate.selectedXParameter].label + ' · ' + FCSFile.FCSParameters[firstGate.selectedYParameter].label + ' Double Zero Gate',
                sampleId: firstGate.sampleId,
                FCSFileId: firstGate.FCSFileId,
                selectedXParameter: firstGate.selectedXParameter,
                selectedYParameter: firstGate.selectedYParameter,
                selectedXScale: firstGate.selectedXScale,
                selectedYScale: firstGate.selectedYScale,
                gateCreator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                gateCreatorData: {},
                populationCount: 0
            }
            const newUnsavedGates = reduxStore.getState().unsavedGates.concat([newGate])
            const setUnsavedGatesAction = setUnsavedGates(newUnsavedGates)
            reduxStore.dispatch(setUnsavedGatesAction)

            api.updateUnsavedGateDerivedData()
        } else {
            const gateIndex = reduxStore.getState().unsavedGates.findIndex(g => g.type === constants.GATE_TYPE_DOUBLE_ZERO)
            if (gateIndex > -1) {
                const newUnsavedGates = reduxStore.getState().unsavedGates.slice(0, gateIndex).concat(reduxStore.getState().unsavedGates.slice(gateIndex + 1))
                const setUnsavedGatesAction = setUnsavedGates(newUnsavedGates)
                reduxStore.dispatch(setUnsavedGatesAction)
            } else {
                console.log('Error trying to toggle double zero unsaved gate, no double zero gate was found.')
            }
        }
    },

    createUnsavedComboGate (gateIds) {
        const firstGate = reduxStore.getState().unsavedGates.slice(0, 1)[0]
        const FCSFile = reduxStore.getState().FCSFiles.find(fcs => fcs.id === firstGate.FCSFileId)
        const includedGates = reduxStore.getState().unsavedGates.filter(g => gateIds.includes(g.id))

        const newGate = {
            id: uuidv4(),
            type: constants.GATE_TYPE_COMBO,
            title: FCSFile.FCSParameters[firstGate.selectedXParameter].label + ' · ' + FCSFile.FCSParameters[firstGate.selectedYParameter].label + ' Combo Gate',
            sampleId: firstGate.sampleId,
            FCSFileId: firstGate.FCSFileId,
            selectedXParameter: firstGate.selectedXParameter,
            selectedYParameter: firstGate.selectedYParameter,
            selectedXScale: firstGate.selectedXScale,
            selectedYScale: firstGate.selectedYScale,
            gateCreator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
            gateCreatorData: {
                gateIds: gateIds
            },
            populationCount: includedGates.reduce((accumulator, current) => { return accumulator + current.populationCount }, 0)
        }
        const newUnsavedGates = reduxStore.getState().unsavedGates.concat([newGate])
        const setUnsavedGatesAction = setUnsavedGates(newUnsavedGates)
        reduxStore.dispatch(setUnsavedGatesAction)
    },

    applyUnsavedGatesToSample: async (sampleId, options) => {
        const sample = reduxStore.getState().samples.find(s => s.id === sampleId)
        const FCSFile = reduxStore.getState().FCSFiles.find(fcs => fcs.id === sample.FCSFileId)
        // Find if there is already a gate template group for this combination or not
        let gateTemplateGroup = reduxStore.getState().gateTemplateGroups.find(g => g.parentGateTemplateId === sample.gateTemplateId && g.selectedXParameter === options.selectedXParameter && g.selectedYParameter === options.selectedYParameter)
        let gateTemplateGroupExists = !!gateTemplateGroup

        const gates = await api.getGatePopulationCounts(reduxStore.getState().unsavedGates)

        if (gateTemplateGroup) {
            for (let gate of gates) {
                if (!gate.gateTemplateId) {
                    let gateTemplate
                    if (gate.type === constants.GATE_TYPE_POLYGON) {
                        gateTemplate = {
                            id: gate.id,
                            type: constants.GATE_TYPE_POLYGON,
                            title: gate.title,
                            creator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                            xGroup: gate.xGroup,
                            yGroup: gate.yGroup,
                            typeSpecificData: gate.gateCreatorData
                        }
                    } else if (gate.type === constants.GATE_TYPE_NEGATIVE) {
                        gateTemplate = {
                            id: gate.id,
                            type: constants.GATE_TYPE_NEGATIVE,
                            title: gate.title,
                            creator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                            typeSpecificData: {}
                        }
                    } else if (gate.type === constants.GATE_TYPE_DOUBLE_ZERO) {
                        gateTemplate = {
                            id: gate.id,
                            type: constants.GATE_TYPE_DOUBLE_ZERO,
                            title: gate.title,
                            creator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                            typeSpecificData: {}
                        }
                    } else if (gate.type === constants.GATE_TYPE_COMBO) {
                        gateTemplate = {
                            id: gate.id,
                            type: constants.GATE_TYPE_COMBO,
                            title: gate.title,
                            creator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                            typeSpecificData: {
                                gateTemplateIds: gate.gateCreatorData.gateIds
                            }
                        }
                    }

                    gate.gateTemplateId = gateTemplate.id
                    gateTemplate.gateTemplateGroupId = gateTemplateGroup.id
                    gateTemplate.workspaceId = sample.workspaceId

                    const createGateTemplateAction = createGateTemplate(gateTemplate)
                    reduxStore.dispatch(createGateTemplateAction)
                }

                // Delete all child samples created as a result of this gate template group
                const matchingSample = reduxStore.getState().samples.find(s => s.gateTemplateId === gate.gateTemplateId && s.parentSampleId === sample.id)
                if (matchingSample) {
                    const removeAction = removeSample(matchingSample.id)
                    reduxStore.dispatch(removeAction)
                }
            }
        } else {
            const gateTemplateGroupId = uuidv4()
            // Create a Gate Template Group for this parameter combination
            const newGateTemplateGroup = {
                id: gateTemplateGroupId,
                workspaceId: sample.workspaceId,
                title: FCSFile.FCSParameters[options.selectedXParameter].label + ' · ' + FCSFile.FCSParameters[options.selectedYParameter].label,
                creator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                selectedXParameter: options.selectedXParameter,
                selectedYParameter: options.selectedYParameter,
                selectedXScale: options.selectedXScale,
                selectedYScale: options.selectedYScale,
                machineType: FCSFile.machineType,
                parentGateTemplateId: sample.gateTemplateId,
                expectedGates: [],
                typeSpecificData: options
            }

            const newGateTemplates = gates.map((gate, index) => {
                let gateTemplate

                if (gate.type === constants.GATE_TYPE_POLYGON) {
                    gateTemplate = {
                        id: gate.id,
                        type: constants.GATE_TYPE_POLYGON,
                        title: gate.title,
                        creator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                        xGroup: gate.xGroup,
                        yGroup: gate.yGroup,
                        typeSpecificData: gate.gateCreatorData
                    }
                } else if (gate.type === constants.GATE_TYPE_NEGATIVE) {
                    gateTemplate = {
                        id: gate.id,
                        type: constants.GATE_TYPE_NEGATIVE,
                        title: gate.title,
                        creator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                        typeSpecificData: {}
                    }
                } else if (gate.type === constants.GATE_TYPE_DOUBLE_ZERO) {
                    gateTemplate = {
                        id: gate.id,
                        type: constants.GATE_TYPE_DOUBLE_ZERO,
                        title: gate.title,
                        creator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                        typeSpecificData: {}
                    }
                } else if (gate.type === constants.GATE_TYPE_COMBO) {
                    gateTemplate = {
                        id: gate.id,
                        type: constants.GATE_TYPE_COMBO,
                        title: gate.title,
                        creator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                        typeSpecificData: {
                            gateTemplateIds: gate.gateCreatorData.gateIds
                        }
                    }
                }

                gate.gateTemplateId = gateTemplate.id
                gateTemplate.gateTemplateGroupId = newGateTemplateGroup.id
                gateTemplate.workspaceId = sample.workspaceId

                const createGateTemplateAction = createGateTemplate(gateTemplate)
                reduxStore.dispatch(createGateTemplateAction)
                return gateTemplate
            })

            const createGateTemplateGroupAction = createGateTemplateGroup(newGateTemplateGroup)
            reduxStore.dispatch(createGateTemplateGroupAction)

            gateTemplateGroup = reduxStore.getState().gateTemplateGroups.find(g => g.id === gateTemplateGroupId)
        }

        const minPeakSize = gates.filter(g => g.type === constants.GATE_TYPE_POLYGON).reduce((accumulator, current) => {
            return Math.min(accumulator, area(current.gateData.polygons[current.gateCreatorData.truePeakWidthIndex]))
        }, Infinity)

        const updateGateTemplateGroupAction = updateGateTemplateGroup(gateTemplateGroup.id, {
            typeSpecificData: Object.assign({}, gateTemplateGroup.typeSpecificData, {
                minPeakSize: Math.min(minPeakSize, options.minPeakSize || gateTemplateGroup.typeSpecificData.minPeakSize),
                minPeakHeight: options.minPeakHeight
            })
        })
        reduxStore.dispatch(updateGateTemplateGroupAction)

        for (let i = 0; i < gates.length; i++) {
            const gate = gates[i]

            gate.workspaceId = sample.workspaceId
            await api.createSubSampleAndAddToWorkspace(
                sample.workspaceId,
                sampleId,
                {
                    parentSampleId: sampleId,
                    workspaceId: sample.workspaceId,
                    FCSFileId: sample.FCSFileId,
                    title: gate.title,
                    filePath: sample.filePath,
                    FCSParameters: FCSFile.FCSParameters,
                    gateTemplateId: gate.gateTemplateId,
                    selectedXParameter: options.selectedXParameter,
                    selectedYParameter: options.selectedYParameter,
                    selectedXScale: options.selectedXScale,
                    selectedYScale: options.selectedYScale
                },
                gate,
            )
        }

        let gatingErrors = reduxStore.getState().gatingErrors.filter(e => gateTemplateGroup && e.gateTemplateGroupId === gateTemplateGroup.id)
        for (let gatingError of gatingErrors) {
            console.log('removing gating error')
            const removeGatingErrorAction = removeGatingError(gatingError.id)
            reduxStore.dispatch(removeGatingErrorAction)
        }

        let samplesToRecalculate = reduxStore.getState().samples.filter(s => s.gateTemplateId === sample.gateTemplateId)
        // Recalculate the gates on other FCS files
        for (let sampleToRecalculate of samplesToRecalculate) {
            api.applyGateTemplatesToSample(sampleToRecalculate.id)
        }

        const loadingFinishedAction = setSampleParametersLoading(sampleId, options.selectedXParameter + '_' + options.selectedYParameter, { loading: false, loadingMessage: null })
        reduxStore.dispatch(loadingFinishedAction)
    },

    applyErrorHandlerToGatingError: async (gatingErrorId, errorHandler) => {
        const gatingError = reduxStore.getState().gatingErrors.find(e => e.id === gatingErrorId)
        const sample = reduxStore.getState().samples.find(s => s.id === gatingError.sampleId)
        const FCSFile = reduxStore.getState().FCSFiles.find(fcs => fcs.id === sample.FCSFileId)
        const gateTemplateGroup = reduxStore.getState().gateTemplateGroups.find(g => g.id === gatingError.gateTemplateGroupId)
        const gateTemplates = reduxStore.getState().gateTemplates.filter(gt => gt.gateTemplateGroupId === gateTemplateGroup.id)

        const loadingStartedAction = setSampleParametersLoading(sample.id, gateTemplateGroup.selectedXParameter + '_' + gateTemplateGroup.selectedYParameter, { loading: true, loadingMessage: 'Recalculating Gates...' })
        reduxStore.dispatch(loadingStartedAction)

        let result
        if (errorHandler.type === constants.GATING_ERROR_HANDLER_AUTO_ANCHORING) {
            let matchingTemplates = []
            let nonMatchingTemplates = []
            for (let gateTemplate of gateTemplates) {
                let foundTemplate = false
                for (let gate of gatingError.gates) {
                    if (gateTemplate.xGroup === gate.xGroup && gateTemplate.yGroup === gate.yGroup) {
                        foundTemplate = true
                        matchingTemplates.push(gateTemplate)
                    }
                }
                if (!foundTemplate) {
                    nonMatchingTemplates.push(gateTemplate)
                }
            }

            if (matchingTemplates.length > 1) {
                const seedPeaks = nonMatchingTemplates.map((template) => {
                    const matchingGate = reduxStore.getState().gates.find(g => g.id === template.exampleGateId)
                    const xGroup = gatingError.gates.find(g => g.xGroup === template.xGroup)
                    const xNucleusValue = xGroup.gateData.nucleus[0]
                    const yGroup = gatingError.gates.find(g => g.yGroup === template.yGroup)
                    const yNucleusValue = yGroup.gateData.nucleus[1]
                    return { id: uuidv4(), position: [ xNucleusValue, yNucleusValue ] }
                })

                const sampleYChannelZeroPeaks = nonMatchingTemplates.map((template) => {
                    const matchingGate = reduxStore.getState().gates.find(g => g.id === template.exampleGateId)
                    const xGroup = gatingError.gates.find(g => g.xGroup === template.xGroup)
                    const xNucleusValue = xGroup.gateData.nucleus[0]

                    return template.typeSpecificData.includeYChannelZeroes ? xNucleusValue : null
                })

                const sampleXChannelZeroPeaks = nonMatchingTemplates.map((template) => {
                    const matchingGate = reduxStore.getState().gates.find(g => g.id === template.exampleGateId)
                    const yGroup = gatingError.gates.find(g => g.yGroup === template.yGroup)
                    const yNucleusValue = yGroup.gateData.nucleus[1]

                    return template.typeSpecificData.includeXChannelZeroes ? yNucleusValue : null
                })

                const options = {
                    selectedXParameter: gateTemplateGroup.selectedXParameter,
                    selectedYParameter: gateTemplateGroup.selectedYParameter,
                    selectedXScale: constants.SCALE_LOG,
                    selectedYScale: constants.SCALE_LOG,
                    machineType: FCSFile.machineType,
                    minXValue: FCSFile.FCSParameters[gateTemplateGroup.selectedXParameter].statistics.positiveMin,
                    maxXValue: FCSFile.FCSParameters[gateTemplateGroup.selectedXParameter].statistics.max,
                    minYValue: FCSFile.FCSParameters[gateTemplateGroup.selectedYParameter].statistics.positiveMin,
                    maxYValue: FCSFile.FCSParameters[gateTemplateGroup.selectedYParameter].statistics.max,
                    plotWidth: reduxStore.getState().plotWidth,
                    plotHeight: reduxStore.getState().plotHeight,
                    seedPeaks,
                    sampleXChannelZeroPeaks,
                    sampleYChannelZeroPeaks
                }

                result = await api.calculateHomology(sample.workspaceId, sample.FCSFileId, sample.id, options)
            }
        } else if (errorHandler.type === constants.GATING_ERROR_HANDLER_MANUAL) {
            const options = {
                selectedXParameter: gateTemplateGroup.selectedXParameter,
                selectedYParameter: gateTemplateGroup.selectedYParameter,
                selectedXScale: constants.SCALE_LOG,
                selectedYScale: constants.SCALE_LOG,
                machineType: FCSFile.machineType,
                minXValue: FCSFile.FCSParameters[gateTemplateGroup.selectedXParameter].statistics.positiveMin,
                maxXValue: FCSFile.FCSParameters[gateTemplateGroup.selectedXParameter].statistics.max,
                minYValue: FCSFile.FCSParameters[gateTemplateGroup.selectedYParameter].statistics.positiveMin,
                maxYValue: FCSFile.FCSParameters[gateTemplateGroup.selectedYParameter].statistics.max,
                plotWidth: reduxStore.getState().plotWidth,
                plotHeight: reduxStore.getState().plotHeight,
                seedPeaks: errorHandler.seedPeaks
            }
            result = await api.calculateHomology(sample.workspaceId, sample.FCSFileId, sample.id, options)
        } else if (errorHandler.type === constants.GATING_ERROR_HANDLER_IGNORE) {
            for (let gateTemplate of gateTemplates) {
                for (let gate of gatingError.gates) {
                    if (gateTemplate.xGroup === gate.xGroup && gateTemplate.yGroup === gate.yGroup) {
                        gate.gateTemplateId = gateTemplate.id
                    }
                }
            }

            result = {
                status: constants.STATUS_SUCCESS,
                data: {
                    gates: gatingError.gates
                }
            }
        }

        const loadingFinishedAction = setSampleParametersLoading(sample.id, gateTemplateGroup.selectedXParameter + '_' + gateTemplateGroup.selectedYParameter, { loading: false, loadingMessage: null })
        reduxStore.dispatch(loadingFinishedAction)

        if (result.status === constants.STATUS_FAIL) {
            if (result.data) {
                let gates = api.createGatePolygons(result.data.gates)
                gates = await api.getGatePopulationCounts(gates)

                const newGatingError = {
                    id: uuidv4(),
                    sampleId: gatingError.sampleId,
                    gateTemplateGroupId: gatingError.gateTemplateGroupId,
                    gates: result.data.gates,
                    criteria: result.data.criteria,
                }
                // Create a gating error
                const createGatingErrorAction = createGatingError(newGatingError)
                reduxStore.dispatch(createGatingErrorAction)

                // Remove the current gating error
                const removeGatingErrorAction = removeGatingError(gatingError.id)
                reduxStore.dispatch(removeGatingErrorAction)
            } else {
                console.log(result)
            }
        } else if (result.status === constants.STATUS_SUCCESS) {
            let gates = api.createGatePolygons(result.data.gates)
            // Create the negative gate if there is one
            const negativeGate = reduxStore.getState().gateTemplates.find(gt => gt.gateTemplateGroupId === gateTemplateGroup.id && gt.type === constants.GATE_TYPE_NEGATIVE)
            if (negativeGate) {
                const newGate = {
                    id: uuidv4(),
                    type: constants.GATE_TYPE_NEGATIVE,
                    title: FCSFile.FCSParameters[gateTemplateGroup.selectedXParameter].label + ' · ' + FCSFile.FCSParameters[gateTemplateGroup.selectedYParameter].label + ' Negative Gate',
                    sampleId: sample.id,
                    FCSFileId: FCSFile.id,
                    gateTemplateId: negativeGate.id,
                    selectedXParameter: gateTemplateGroup.selectedXParameter,
                    selectedYParameter: gateTemplateGroup.selectedYParameter,
                    selectedXScale: gateTemplateGroup.selectedXScale,
                    selectedYScale: gateTemplateGroup.selectedYScale,
                    gateCreator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                    gateCreatorData: {},
                    populationCount: 0
                }

                gates.push(newGate)
            }

            // Create the double zero gate if there is one
            const doubleZeroGate = reduxStore.getState().gateTemplates.find(gt => gt.gateTemplateGroupId === gateTemplateGroup.id && gt.type === constants.GATE_TYPE_DOUBLE_ZERO)
            if (doubleZeroGate) {
                const newGate = {
                    id: uuidv4(),
                    type: constants.GATE_TYPE_DOUBLE_ZERO,
                    title: FCSFile.FCSParameters[gateTemplateGroup.selectedXParameter].label + ' · ' + FCSFile.FCSParameters[gateTemplateGroup.selectedYParameter].label + ' Double Zero Gate',
                    sampleId: sample.id,
                    FCSFileId: FCSFile.id,
                    gateTemplateId: doubleZeroGate.id,
                    selectedXParameter: gateTemplateGroup.selectedXParameter,
                    selectedYParameter: gateTemplateGroup.selectedYParameter,
                    selectedXScale: gateTemplateGroup.selectedXScale,
                    selectedYScale: gateTemplateGroup.selectedYScale,
                    gateCreator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                    gateCreatorData: {},
                    populationCount: 0
                }

                gates.push(newGate)
            }

            gates = await api.getGatePopulationCounts(gates)

            // Create combo gates AFTER we know which events are in each smaller gate so that they can be concatted for combo gate contents
            const comboGates = reduxStore.getState().gateTemplates.filter(gt => gt.gateTemplateGroupId === gateTemplateGroup.id && gt.type === constants.GATE_TYPE_COMBO)
            for (let comboGate of comboGates) {
                const includedGates = gates.filter(g => comboGate.typeSpecificData.gateTemplateIds.includes(g.gateTemplateId))
                const newGate = {
                    id: uuidv4(),
                    type: constants.GATE_TYPE_COMBO,
                    title: FCSFile.FCSParameters[gateTemplateGroup.selectedXParameter].label + ' · ' + FCSFile.FCSParameters[gateTemplateGroup.selectedYParameter].label + ' Combo Gate',
                    sampleId: sample.id,
                    FCSFileId: FCSFile.id,
                    gateTemplateId: comboGate.id,
                    selectedXParameter: gateTemplateGroup.selectedXParameter,
                    selectedYParameter: gateTemplateGroup.selectedYParameter,
                    selectedXScale: gateTemplateGroup.selectedXScale,
                    selectedYScale: gateTemplateGroup.selectedYScale,
                    gateCreator: constants.GATE_CREATOR_PERSISTENT_HOMOLOGY,
                    gateCreatorData: {
                        gateIds: includedGates.map(g => g.id)
                    },
                    populationCount: includedGates.reduce((accumulator, current) => { return accumulator + current.populationCount }, 0)
                }
                gates.push(newGate)
            }

            if (gates.length > 0) {
                const setUnsavedGatesAction = setUnsavedGates(gates)
                reduxStore.dispatch(setUnsavedGatesAction)

                api.updateUnsavedGateDerivedData()
            }

            const loadingFinishedAction = setSampleParametersLoading(sample.id, gateTemplateGroup.selectedXParameter + '_' + gateTemplateGroup.selectedYParameter, { loading: false, loadingMessage: null })
            reduxStore.dispatch(loadingFinishedAction)
        }
    },

    getJobsApiUrl: () => {
        return 'https://localhost:3146'
    },

    dragImage: (filePath, event) => {
        event.preventDefault()
        event.nativeEvent.effectAllowed = 'copy'
        ipcRenderer.send('ondragstart', filePath)
    },

    generatePlotImage: (parameters) => {
        pushToQueue({
            jobParameters: { url: 'http://127.0.0.1:3145', json: { jobId: uuidv4(), type: 'generate-plot-image', payload: parameters } },
            jobKey: JSON.stringify(parameters),
            checkValidity: () => { return true },
            callback: (data) => { }
        }, true)
    }
}