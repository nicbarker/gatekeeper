// -------------------------------------------------------------
// IPC wrapper for running cpu intensive subprocess tasks
// -------------------------------------------------------------

const assetDirectory = process.argv[2]

import { getPopulationForSample, getFullSubSamplePopulation } from '../lib/get-population-data.js'
import fs from 'fs'
import getImageForPlot from '../lib/get-image-for-plot.js'
import PersistentHomology from '../lib/persistent-homology.js'
import getFCSMetadata from './lib/get-fcs-metadata.js'
import find1DPeaks from './lib/1d-homology'
import { expandToIncludeZeroes, findIncludedEvents } from './lib/gate-utilities'
import _ from 'lodash'

const cluster = require('cluster');
const http = require('http');
const numCPUs = Math.max(require('os').cpus().length - 1, 1);

if (cluster.isMaster) {
  // Fork workers.
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`worker ${worker.process.pid} died, starting a new worker`);
    cluster.fork();
  });
} else {
    console.log(`Child ${process.pid} is running`);
    const populationCache = {}

    const getPopulation = (sample, FCSFile, options) => {
        const key = `${sample.id}-${options.selectedXParameterIndex}_${options.selectedXScale}-${options.selectedYParameterIndex}_${options.selectedYScale}`
        
        return new Promise((resolve, reject) => {
            if (populationCache[key]) {
                resolve(populationCache[key])
            } else {
                getPopulationForSample(sample, FCSFile, options).then((data) => {
                    populationCache[key] = data
                    if (_.keys(populationCache).length > 10) {
                        delete populationCache[_.keys(populationCache).slice(-1)[0]]
                    }
                    resolve(data)
                }).catch((error) => {
                    console.log(error)
                    process.stderr.write(JSON.stringify({ jobId, data: JSON.stringify(error) }))
                })
            }
        })
    }

    const handleError = (error) => {
        console.log(error)
        process.stderr.write(JSON.stringify({ jobId, data: JSON.stringify(error) }))
        res.end(JSON.stringify({ jobId, data: JSON.stringify(error) }))
    }

    http.createServer((req, res) => {
        res.writeHead(200);
        let bodyRaw = ''
        req.on('data', chunk => bodyRaw += chunk)
        req.on('end', () => {
            const body = JSON.parse(bodyRaw)
            const jobId = body.jobId
            if (body.type === 'heartbeat') {
                heartbeatTime = process.hrtime()[0]
            } else {
                if (body.payload.options) {
                    body.payload.options = _.merge(body.payload.options, { assetDirectory })
                }
// get-fcs-metadata
                if (body.type === 'get-fcs-metadata') {
                    getFCSMetadata(body.payload.filePath).then((data) => {
                        process.stdout.write(JSON.stringify({ jobId: body.jobId, data: 'Finished job on worker side'}))
                        res.end(JSON.stringify(data))
                    })

// get-population-data
                } else if (body.type === 'get-population-data') {
                    getPopulation(body.payload.sample, body.payload.FCSFile, body.payload.options).then((data) => { res.end(JSON.stringify(data)) }).catch(handleError)

// save-subsample-to-csv
                } else if (body.type === 'save-subsample-to-csv') {
                    getFullSubSamplePopulation(body.payload.sample, body.payload.FCSFile)
                    .then((data) => {
                        const header = body.payload.FCSFile.FCSParameters.map(p => p.key).join(',') + '\n'
                        fs.writeFile(body.payload.filePath, header, function (error) {
                            fs.appendFile(body.payload.filePath, data.map(p => p[0].join(',')).join('\n'), function (error) {
                                res.end(JSON.stringify({ status: 'success' }))
                            });
                        });
                    }).catch(handleError)

// get-image-for-plot
                } else if (body.type === 'get-image-for-plot') {
                    // console.log(body.payload.options)
                    getPopulation(body.payload.sample, body.payload.FCSFile, body.payload.options).then((population) => {
                        getImageForPlot(body.payload.sample, body.payload.FCSFile, population, body.payload.options).then((data) => {
                            res.end(JSON.stringify(data))
                        }).catch(handleError)
                    })

// find-peaks
                } else if (body.type === 'find-peaks') {
                    getPopulation(body.payload.sample, body.payload.FCSFile, body.payload.options).then((population) => {
                        const homology = new PersistentHomology(population, body.payload.options)
                        let percentageComplete = 0
                        const data = homology.findPeaks((message) => {
                            // console.log({ jobId: jobId, type: 'loading-update', data: message })
                            // res.send({ jobId: jobId, type: 'loading-update', data: message })
                        })
                        res.end(JSON.stringify(data))
                    }).catch(handleError)

// find-peaks-with-templates
                } else if (body.type === 'find-peaks-with-template') {
                    getPopulation(body.payload.sample, body.payload.FCSFile, body.payload.options).then((population) => {
                        const homology = new PersistentHomology(population, body.payload.options)
                        let percentageComplete = 0
                        const data = homology.findPeaksWithTemplate((message) => {
                            // console.log({ jobId: jobId, type: 'loading-update', data: message })
                            // res.send({ jobId: jobId, type: 'loading-update', data: message })
                        }, body.payload.gateTemplates)
                        res.end(JSON.stringify(data))
                    }).catch(handleError)
                                    
// get-expanded-gates
                } else if (body.type === 'get-expanded-gates') {
                    getPopulation(body.payload.sample, body.payload.FCSFile, body.payload.options).then((population) => {
                        const xOptions = _.clone(body.payload.options)
                        xOptions.knownPeaks = xOptions.sampleXChannelZeroPeaks
                        const xCutoffs = find1DPeaks(population.zeroDensityX.densityMap, population.maxDensity, xOptions)
                        
                        const yOptions = _.clone(body.payload.options)
                        yOptions.knownPeaks = xOptions.sampleYChannelZeroPeaks
                        const yCutoffs = find1DPeaks(population.zeroDensityY.densityMap, population.maxDensity, yOptions)

                        const expandedGates = expandToIncludeZeroes(xCutoffs, yCutoffs, body.payload.gates, body.payload.options)
                        res.end(JSON.stringify(expandedGates))
                    }).catch(handleError)

// get-included-events
                } else if (body.type === 'get-included-events') {
                    getPopulation(body.payload.sample, body.payload.FCSFile, body.payload.options).then((population) => {
                        const alteredGates = findIncludedEvents(body.payload.gates, population, body.payload.FCSFile, body.payload.options)
                        res.end(JSON.stringify(alteredGates))
                    }).catch(handleError)
                }
            }  
        })
    }).listen(3145);
}

process.on('disconnect', function() {
  console.log('parent exited')
  process.exit();
});