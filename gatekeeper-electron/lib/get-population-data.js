// -------------------------------------------------------------------------
// Generates a PNG for a plot with options and saves it to the disk.
// -------------------------------------------------------------------------

import fs from 'fs-extra'
import mkdirp from 'mkdirp'
import FCS from 'fcs'
import _ from 'lodash'
import path from 'path'
import { scaleLog } from 'd3-scale'
import { getScales, getPlotImageKey, getMetadataFromFCSFileText, getMetadataFromCSVFileHeader } from '../../gatekeeper-utilities/utilities'
import constants from '../../gatekeeper-utilities/constants'

// Wrap the read file function from FS in a promise
const readFileBuffer = (path) => {
    return new Promise((res, rej) => {
        fs.readFile(path, (err, buffer) => {
            if (err) rej(err)
            else res(buffer)
        })
    })
}

// Wrap the read file function from FS in a promise
const readFile = (path, opts = 'utf8') => {
    return new Promise((res, rej) => {
        fs.readFile(path, opts, (err, data) => {
            if (err) rej(err)
            else res(data)
        })
    })
}

const mkdirpPromise = (directory) => {
    return new Promise((resolve, reject) => {
        mkdirp(directory, function (error) {
            if (error) { console.error(error) && reject(error) }
            resolve()
        });
    })
}

const FCSFileCache = {}
const CSVFileCache = {}

const unblock = async () => {
    new Promise((resolve, reject) => { _.defer(resolve) })
}

const getFCSFileFromPath = async (filePath) => {
    if (FCSFileCache[filePath]) {
        return FCSFileCache[filePath]
    }
    // Read in the data from the FCS file, and emit another action when finished
    try {
        const buffer = await readFileBuffer(filePath)
        const FCSFile = new FCS({ dataFormat: 'asNumber', eventsToRead: -1 }, buffer)
        FCSFileCache[filePath] = FCSFile
        return FCSFile
    } catch (error) {
        process.stderr.write(JSON.stringify(error))
    }
}

const getCSVFileFromPath = async (filePath) => {
    if (CSVFileCache[filePath]) {
        return CSVFileCache[filePath]
    }
    // Read in the data from the CSV file, and emit another action when finished
    const file = await readFile(filePath)
    const CSVFile = file.split('\n').map(row => row.split(','))
    CSVFileCache[filePath] = {
        headers: getMetadataFromCSVFileHeader(CSVFile[0]),
        data: CSVFile.slice(1)
    }
    return CSVFileCache[filePath]
}

// Data should be an array of 2d points, in [x, y] format i.e. [[1, 1], [2, 2]]
async function calculateDensity (points, scales, densityWidth = 2, options) {
    // Create a sorted point cache that's accessible by [row][column] for faster density estimation
    const pointCache = []
    let maxDensity = 0

    for (let i = 0; i < points.length; i++) {
        const point = points[i]

        const xVal = Math.round(scales.xScale(point[0]))
        const yVal = Math.round(scales.yScale(point[1]))

        if (!pointCache[yVal]) {
            pointCache[yVal] = []
        }
        if (!pointCache[yVal][xVal]) {
            pointCache[yVal][xVal] = 1
        } else {
            pointCache[yVal][xVal] += 1
        }

        if (i % 10000 === 0) {
            await unblock()
        }
    }

    const newDensityMap = Array(options.plotHeight).fill(0)

    for (let y = 0; y < options.plotHeight; y++) {
        newDensityMap[y] = Array(options.plotWidth).fill(0)

        // console.log('row', y)
        let incrementors = []
        for (let x = 0; x < options.plotWidth; x++) {

            for (let i = 0; i < incrementors.length; i++) {
                incrementors[i].currentValue -= incrementors[i].originalValue / densityWidth

                if (Math.round(incrementors[i].currentValue * 10) / 10 === 0) {
                    incrementors.splice(i, 1)
                    i--
                }
            }

            // console.log('incrementors', incrementors)

            for (let i = 0; i < incrementors.length; i++) {
                newDensityMap[y][x] += incrementors[i].currentValue
            }

            if (pointCache[y] && pointCache[y][x]) {
                // newDensityMap[y][x] += pointCache[y][x]
                incrementors.push({ originalValue: pointCache[y][x], currentValue: pointCache[y][x] })
            }
        }
        // console.log(newDensityMap)
    }

    await unblock()

    // incrementorCache = Array(options.plotWidth).fill(0)

    // console.log('--------------------------------------------------------------------')

    for (let y = 0; y < options.plotHeight; y++) {
        // console.log('row', y)
        let incrementors = []
        for (let x = options.plotWidth - 1; x > -1; x--) {

            for (let i = 0; i < incrementors.length; i++) {
                incrementors[i].currentValue -= incrementors[i].originalValue / densityWidth

                if (Math.round(incrementors[i].currentValue * 10) / 10 === 0) {
                    incrementors.splice(i, 1)
                    i--
                }
            }

            // console.log('incrementors', incrementors)

            for (let i = 0; i < incrementors.length; i++) {
                newDensityMap[y][x] += incrementors[i].currentValue
            }

            if (pointCache[y] && pointCache[y][x]) {
                // newDensityMap[y][x] += pointCache[y][x]
                incrementors.push({ originalValue: pointCache[y][x], currentValue: pointCache[y][x] })
            }
        }
        // console.log(newDensityMap)
    }

    await unblock()

    // incrementorCache = Array(options.plotWidth).fill(0)

    // console.log('--------------------------------------------------------------------')

    for (let x = 0; x < options.plotWidth; x++) {
        // console.log('column', x)
        let incrementors = []
        for (let y = 0; y < options.plotHeight; y++) {

            for (let i = 0; i < incrementors.length; i++) {
                incrementors[i].currentValue -= incrementors[i].originalValue / densityWidth

                if (Math.round(incrementors[i].currentValue * 10) / 10 === 0) {
                    incrementors.splice(i, 1)
                    i--
                }
            }

            // console.log('incrementors', incrementors)

            for (let i = 0; i < incrementors.length; i++) {
                newDensityMap[y][x] += incrementors[i].currentValue
            }

            if (pointCache[y] && pointCache[y][x]) {
                // newDensityMap[y][x] += pointCache[y][x]
                incrementors.push({ originalValue: pointCache[y][x], currentValue: pointCache[y][x] })
            }
        }
        // console.log(newDensityMap)
    }

    await unblock()

    // // incrementorCache = Array(options.plotWidth).fill(0)

    // console.log('--------------------------------------------------------------------')

    for (let x = 0; x < options.plotWidth; x++) {
        // console.log('column', x)
        let incrementors = []
        for (let y = options.plotHeight - 1; y > -1; y--) {

            for (let i = 0; i < incrementors.length; i++) {
                incrementors[i].currentValue -= incrementors[i].originalValue / densityWidth

                if (Math.round(incrementors[i].currentValue * 10) / 10 === 0) {
                    incrementors.splice(i, 1)
                    i--
                }
            }

            // console.log('incrementors', incrementors)

            for (let i = 0; i < incrementors.length; i++) {
                newDensityMap[y][x] += incrementors[i].currentValue
            }

            if (pointCache[y] && pointCache[y][x]) {
                // newDensityMap[y][x] += pointCache[y][x]
                incrementors.push({ originalValue: pointCache[y][x], currentValue: pointCache[y][x] })
            }
        }
        // console.log(newDensityMap)
    }

    await unblock()

    // console.log('--------------------------------------------------------------------')

    for (let x = 0; x < options.plotWidth; x++) {
        for (let y = options.plotHeight - 1; y > -1; y--) {
            if (pointCache[y] && pointCache[y][x]) {
                newDensityMap[y][x] += pointCache[y][x]
            }
        }
    }

    await unblock()

    for (let y = 1; y < options.plotHeight - 1; y++) {
        for (let x = 1; x < options.plotWidth - 1; x++) {
            const toAdd = (newDensityMap[y - 1][x - 1] + newDensityMap[y - 1][x + 1] + newDensityMap[y + 1][x - 1] + newDensityMap[y + 1][x + 1]) / 4
            newDensityMap[y][x] += toAdd
            maxDensity = Math.max(maxDensity, newDensityMap[y][x])
        }
    }

    await unblock()

    return {
        densityMap: newDensityMap,
        maxDensity,
        // meanDensity
    }
}

async function calculateDensity1D (points, scale, densityWidth = 2) {
    // Create a sorted point cache that's accessible by [row] for faster density estimation
    const pointCache = Array(points.length).fill(0)
    let maxDensity = 0

    for (let i = 0; i < points.length; i++) {
        const point = points[i][0]

        const val = Math.round(scale(point))

        if (val < 0) { continue }

        pointCache[val] += 1
    }

    const newDensityMap = Array(points.length).fill(0)
    let incrementors = []
    for (let x = 0; x < pointCache.length; x++) {

        for (let i = 0; i < incrementors.length; i++) {
            incrementors[i].currentValue -= incrementors[i].originalValue / densityWidth

            if (Math.round(incrementors[i].currentValue * 10) / 10 === 0) {
                incrementors.splice(i, 1)
                i--
            }
        }

        for (let i = 0; i < incrementors.length; i++) {
            newDensityMap[x] += incrementors[i].currentValue
            if (newDensityMap[x] > maxDensity) {
                maxDensity = newDensityMap[x]
            }
        }

        if (pointCache[x]) {
            incrementors.push({ originalValue: pointCache[x], currentValue: pointCache[x] })
        }
    }

    incrementors = []
    for (let x = pointCache.length - 1; x > -1; x--) {

        for (let i = 0; i < incrementors.length; i++) {
            incrementors[i].currentValue -= incrementors[i].originalValue / densityWidth

            if (Math.round(incrementors[i].currentValue * 10) / 10 === 0) {
                incrementors.splice(i, 1)
                i--
            }
        }

        for (let i = 0; i < incrementors.length; i++) {
            newDensityMap[x] += incrementors[i].currentValue
            if (newDensityMap[x] > maxDensity) {
                maxDensity = newDensityMap[x]
            }
        }

        if (pointCache[x]) {
            incrementors.push({ originalValue: pointCache[x], currentValue: pointCache[x] })
        }
    }

    for (let x = 0; x < pointCache.length; x++) {
        if (pointCache[x]) {
            newDensityMap[x] += pointCache[x] / 2
            if (newDensityMap[x] > maxDensity) {
                maxDensity = newDensityMap[x]
            }
        }
    }

    return {
        densityMap: newDensityMap,
        maxDensity
    }
}

async function getFullSubSamplePopulation (workspaceId, FCSFileId, sampleId) {
    const assetDirectory = process.argv[2]
    const filePath = path.join(assetDirectory, 'workspaces', workspaceId, FCSFileId, sampleId, 'include-event-ids.json')

    let toReturn = []

    let FCSFileData
    try  {
        FCSFileData = await getFCSFileFromPath(path.join(assetDirectory, 'workspaces', workspaceId, FCSFileId, FCSFileId + '.fcs'))
    } catch (error) {
        process.stderr.write(JSON.stringify(error))
        return
    }

    let includeEventIds = {}
    try {
        includeEventIds = JSON.parse(await readFile(filePath))
    } catch (error) {
        console.log("Couldn't find cached population file", error)
        return FCSFileData.dataAsNumbers.map((p, index) => { return [p, index] })
    }

    const subPopulation = [ getMetadataFromFCSFileText(FCSFileData.text).map(m => m.key) ]
    for (let i = 0; i < includeEventIds.length; i++) {
        subPopulation.push(FCSFileData.dataAsNumbers[includeEventIds[i]])
    }

    return subPopulation
}

async function getPopulationForSampleInternal (workspaceId, FCSFileId, sampleId, options) {
    const assetDirectory = process.argv[2]
    const directory = path.join(assetDirectory, 'workspaces', workspaceId, FCSFileId, sampleId)
    const sampleKey = getPlotImageKey(options)
    const filePath = path.join(directory, `${sampleKey}.json`)

    try {
        return JSON.parse(await readFile(filePath))
    } catch (error) {
        // console.log("Couldn't find cached population file", error)
    }

    await mkdirpPromise(directory)

    let fileData
    let isCSV
    try  {
        const FCSFile = await getFCSFileFromPath(path.join(assetDirectory, 'workspaces', workspaceId, FCSFileId, FCSFileId + '.fcs'))
        fileData = FCSFile.dataAsNumbers
    } catch (error) {
        try {
            const CSVFile = await getCSVFileFromPath(path.join(assetDirectory, 'workspaces', workspaceId, FCSFileId, FCSFileId + '.csv'))
            fileData = CSVFile.data
            isCSV = true
        } catch (error2) {
            console.log(error2.message)
            return
        }
    }

    let xOffset = options.machineType === constants.MACHINE_CYTOF ? Math.round(Math.min(options.plotWidth, options.plotHeight) * 0.07) : 0
    let yOffset = options.machineType === constants.MACHINE_CYTOF ? Math.round(Math.min(options.plotWidth, options.plotHeight) * 0.07) : 0

    const subPopulation = []
    const aboveZeroPopulation = []
    const doubleChannelZeroes = []
    const xChannelZeroes = []
    const yChannelZeroes = []
    const scaledPopulation = []

    let includeEventIds = []
    try {
        if (options.gatingHash) {
            const eventResults = await readFile(path.join(assetDirectory, 'workspaces', workspaceId, FCSFileId, 'other-samples', options.gatingHash, 'include-event-ids.json'))
            includeEventIds = JSON.parse(eventResults)
        } else {
            const eventResults = await readFile(path.join(assetDirectory, 'workspaces', workspaceId, FCSFileId, sampleId, 'include-event-ids.json'))
            includeEventIds = JSON.parse(eventResults)
        }
    } catch (error) {
        // console.log(error)
    }

    const scales = getScales({
        selectedXScale: options.selectedXScale,
        selectedYScale: options.selectedYScale,
        xRange: [ options.minXValue, options.maxXValue ],
        yRange: [ options.minYValue, options.maxYValue ],
        width: options.plotWidth - xOffset,
        height: options.plotHeight - yOffset
    })

    if (includeEventIds && includeEventIds.length > 0) {
        for (let i = 0; i < includeEventIds.length; i++) {
            let point = fileData[includeEventIds[i]]
            if (isCSV) {
                point[options.selectedXParameterIndex] = parseFloat(point[options.selectedXParameterIndex], 10)
                point[options.selectedYParameterIndex] = parseFloat(point[options.selectedYParameterIndex], 10)
            }

            if (options.machineType === constants.MACHINE_CYTOF) {
                // Every point that has a zero in the selected X channel
                if (point[options.selectedXParameterIndex] === 0 && point[options.selectedYParameterIndex] === 0) {
                    doubleChannelZeroes.push([ point[options.selectedXParameterIndex], includeEventIds[i] ])
                }
                // Every point that has a zero in the selected X channel
                else if (point[options.selectedXParameterIndex] === 0) {
                    xChannelZeroes.push([ point[options.selectedYParameterIndex], includeEventIds[i] ])
                // Every point that has a zero in the selected Y channel
                } else if (point[options.selectedYParameterIndex] === 0) {
                    yChannelZeroes.push([ point[options.selectedXParameterIndex], includeEventIds[i] ])
                } else {
                    aboveZeroPopulation.push([ point[options.selectedXParameterIndex], point[options.selectedYParameterIndex], includeEventIds[i] ])
                }
            } else {
                aboveZeroPopulation.push([ point[options.selectedXParameterIndex], point[options.selectedYParameterIndex], includeEventIds[i] ])
            }

            subPopulation.push([ point[options.selectedXParameterIndex], point[options.selectedYParameterIndex], includeEventIds[i] ])

            if (i % 10000 === 0) {
                await new Promise((resolve, reject) => { _.defer(resolve) })
            }
        }
    } else {
        for (let i = 0; i < fileData.length; i++) {
            let point = fileData[i]
            if (isCSV) {
                point[options.selectedXParameterIndex] = parseFloat(point[options.selectedXParameterIndex], 10)
                point[options.selectedYParameterIndex] = parseFloat(point[options.selectedYParameterIndex], 10)
            }
            if (options.machineType === constants.MACHINE_CYTOF) {
                // Every point that has a zero in the selected X channel
                if (point[options.selectedXParameterIndex] === 0 && point[options.selectedYParameterIndex] === 0) {
                    doubleChannelZeroes.push([ point[options.selectedYParameterIndex], i ])
                }
                // Every point that has a zero in the selected X channel
                else if (point[options.selectedXParameterIndex] === 0) {
                    xChannelZeroes.push([ point[options.selectedYParameterIndex], i ])
                // Every point that has a zero in the selected Y channel
                } else if (point[options.selectedYParameterIndex] === 0) {
                    yChannelZeroes.push([ point[options.selectedXParameterIndex], i ])
                } else {
                    scaledPopulation.push([ scales.xScale(point[options.selectedXParameterIndex]), scales.yScale(point[options.selectedYParameterIndex]) ])
                    aboveZeroPopulation.push([ point[options.selectedXParameterIndex], point[options.selectedYParameterIndex], i ])
                }
                subPopulation.push([ point[options.selectedXParameterIndex], point[options.selectedYParameterIndex], i ])
            } else {
                subPopulation.push([ point[options.selectedXParameterIndex], point[options.selectedYParameterIndex], i ])
                scaledPopulation.push([ scales.xScale(point[options.selectedXParameterIndex]), scales.yScale(point[options.selectedYParameterIndex]) ])
                aboveZeroPopulation.push([ point[options.selectedXParameterIndex], point[options.selectedYParameterIndex], i ])
            }

            if (i % 10000 === 0) {
                await new Promise((resolve, reject) => { _.defer(resolve) })
            }
        }
    }

    // Density width gets larger as plot size increases, and as number of events in the file decreases
    const densityWidth = Math.floor((options.plotWidth + options.plotHeight) * 0.012) + (Math.floor(300000 / fileData.length) * 5)

    const densityMap = await calculateDensity(aboveZeroPopulation, scales, densityWidth, options)

    let zeroDensityY
    let zeroDensityX
    let maxDensityY
    let maxDensityX
    let doubleChannelZeroDensity

    if (options.machineType === constants.MACHINE_CYTOF) {
        zeroDensityX = await calculateDensity1D(xChannelZeroes, scales.yScale, densityWidth)
        zeroDensityY = await calculateDensity1D(yChannelZeroes, scales.xScale, densityWidth)
    }

    let realMaxDensity = densityMap.maxDensity
    if (zeroDensityX) {
        realMaxDensity = Math.max(realMaxDensity, zeroDensityX.maxDensity)
    }
    if (zeroDensityY) {
        realMaxDensity = Math.max(realMaxDensity, zeroDensityY.maxDensity)
    }
    if (doubleChannelZeroes.length > 0) {
        doubleChannelZeroDensity = doubleChannelZeroes.length / 4
        realMaxDensity = Math.max(realMaxDensity, doubleChannelZeroDensity)
    }

    const densityScale = scaleLog()
        .range([0, 100])
        .domain([1, realMaxDensity])

    const scaleValue = (value) => {
        return Math.min(Math.max(densityScale(value), 0.1), 100)
    }

    for (let i = 0; i < densityMap.densityMap.length; i++) {
        if (densityMap.densityMap[i]) {
            for (let j = 0; j < densityMap.densityMap[i].length; j++) {
                if (densityMap.densityMap[i][j]) {
                    densityMap.densityMap[i][j] = scaleValue(densityMap.densityMap[i][j])
                }
            }
        }
    }

    if (zeroDensityX) {
        for (let i = 0; i < zeroDensityX.densityMap.length; i++) {
            if (zeroDensityX.densityMap[i]) {
                if (zeroDensityX.densityMap[i]) {
                    zeroDensityX.densityMap[i] = scaleValue(zeroDensityX.densityMap[i])
                }
            }
        }
    }

    if (zeroDensityY) {
        for (let i = 0; i < zeroDensityY.densityMap.length; i++) {
            if (zeroDensityY.densityMap[i]) {
                if (zeroDensityY.densityMap[i]) {
                    zeroDensityY.densityMap[i] = scaleValue(zeroDensityY.densityMap[i])
                }
            }
        }
    }

    realMaxDensity = scaleValue(realMaxDensity)
    doubleChannelZeroDensity = scaleValue(doubleChannelZeroDensity)
    densityMap.maxDensity = scaleValue(densityMap.maxDensity)
    zeroDensityX.maxDensity = scaleValue(zeroDensityX.maxDensity)
    zeroDensityY.maxDensity = scaleValue(zeroDensityY.maxDensity)

    const toReturn = {
        subPopulation,
        scaledPopulation,
        aboveZeroPopulation,
        doubleChannelZeroes,
        doubleChannelZeroDensity,
        xChannelZeroes,
        yChannelZeroes,
        densityMap,
        zeroDensityX,
        zeroDensityY,
        maxDensity: realMaxDensity
    }

    fs.writeFile(filePath, JSON.stringify(toReturn), (error) => { if (error) { console.log(error) } /* console.log('population data saved to disk') */ })

    return toReturn
}

async function getPopulationForSample (workspaceId, FCSFileId, sampleId, options) {
    return await getPopulationForSampleInternal(workspaceId, FCSFileId, sampleId, options)
}

export { getFullSubSamplePopulation, getPopulationForSample }