// -------------------------------------------------------------
// HTTP wrapper for running cpu intensive subprocess tasks
// -------------------------------------------------------------

const assetDirectory = process.argv[2]

import { getPopulationForSample, getFullSubSamplePopulation }   from './lib/get-population-data.js'
import getImageForPlot                                          from './lib/get-image-for-plot.js'
import PersistentHomology                                       from './lib/persistent-homology.js'
import getFCSMetadata                                           from './lib/get-fcs-metadata.js'
import { expandToIncludeZeroes, findIncludedEvents }            from './lib/gate-utilities'
import find1DPeaks                                              from './lib/1d-homology'
import importFCSFile                                            from './lib/import-fcs-file'
import constants                                                from '../gatekeeper-utilities/constants'
import { getPlotImageKey }                                      from '../gatekeeper-utilities/utilities'
import fs                                                       from 'fs'
import fcs                                                      from 'fcs'
import _                                                        from 'lodash'
import path                                                     from 'path'
import mkdirp                                                   from 'mkdirp'
import cluster                                                  from 'cluster'
import http                                                     from 'http'
import http2                                                    from 'http2'
import url                                                      from 'url'

const numCPUs = Math.max(require('os').cpus().length - 2, 1);

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

    const handleError = (response, error) => {
        console.log(error)
        response.end(JSON.stringify({ status: constants.STATUS_FAIL, error: error.message }))
    }

    const imageServer = http2.createSecureServer({
        key: fs.readFileSync(path.join(assetDirectory, 'certs', 'localhost.key')),
        cert: fs.readFileSync(path.join(assetDirectory, 'certs', 'localhost.crt'))
    });

    imageServer.on('error', (err) => console.error(err));

    imageServer.on('stream', (stream, headers) => {
        const parsedUrl = url.parse(headers[':path'], true)
        if (parsedUrl.pathname === '/plot_images') {
            const query = parsedUrl.query
            for (let key of ['plotWidth', 'plotHeight', 'minXValue', 'maxXValue', 'minYValue', 'maxYValue', 'selectedXParameterIndex', 'selectedYParameterIndex']) {
                query[key] = parseFloat(query[key])
            }
            const fileName = getPlotImageKey(query) + '.png'
            const filePath = path.join(assetDirectory, 'workspaces', query.workspaceId, query.FCSFileId, query.sampleId, fileName)

            fs.readFile(filePath, (error, data) => {
                if (error) {
                    try {
                        stream.respond({
                            'content-type': null,
                            ':status': 201
                        })
                        stream.end()
                    } catch (error) {
                        console.log(error)
                    }
                } else {
                    try {
                        stream.respond({
                            'content-type': 'image/png',
                            ':status': 200
                        })
                        stream.end(data)
                    } catch (error) {
                        console.log(error)
                    }
                }
            })
        }
    });

    imageServer.listen(3146)

    http.createServer((request, response) => {
        let bodyRaw = ''
        request.on('data', chunk => bodyRaw += chunk)
        request.on('end', () => {
            const parsedUrl = url.parse(request.url,true)

            response.writeHead(200, { 'Content-Type' : 'application/json' })
            let body = { payload: {} }
            try {
                body = JSON.parse(bodyRaw)
            } catch (error) {
                response.end(JSON.stringify('warning: no json was supplied with input'))
            }

            const jobId = body.jobId
            if (body.payload.options) {
                body.payload.options = _.merge(body.payload.options, { assetDirectory })
            }
// import-fcs-file
            if (body.type === 'import-fcs-file') {
                importFCSFile(body.payload.workspaceId, body.payload.FCSFileId, body.payload.filePath).then(() => {
                    response.end(JSON.stringify({ success: true }))
                })

// get-fcs-metadata
            } else if (body.type === 'get-fcs-metadata') {
                getFCSMetadata(body.payload.workspaceId, body.payload.FCSFileId, body.payload.fileName).then((data) => {
                    response.end(JSON.stringify(data))
                })

// generate-plot-image
            } else if (body.type === 'generate-plot-image') {
                const fileName = getPlotImageKey(body.payload) + '.png'
                fs.readFile(path.join(assetDirectory, 'workspaces', body.payload.workspaceId, body.payload.FCSFileId, body.payload.sampleId, fileName), (err, data) => {
                    if (err) {
                        getPopulationForSample(body.payload.workspaceId, body.payload.FCSFileId, body.payload.sampleId, body.payload).then((population) => {
                            getImageForPlot(body.payload.workspaceId, body.payload.FCSFileId, body.payload.sampleId, population, body.payload)
                            .then(() => {
                                response.end(JSON.stringify({ status: 'success' }))
                            }).catch(handleError.bind(null, response))
                        }).catch(handleError.bind(null, response))
                    } else {
                        response.end(JSON.stringify({ status: 'success' }))
                    }
                })                   
// save-subsample-to-csv
            } else if (body.type === 'save-subsample-to-csv') {
                getFullSubSamplePopulation(body.payload.workspaceId, body.payload.FCSFileId, body.payload.sampleId, body.payload.options)
                .then((data) => {
                    const header = data[0].join(',') + '\n'
                    fs.writeFile(body.payload.filePath, header, function (error) {
                        fs.appendFile(body.payload.filePath, data.slice(1).map(p => p.join(',')).join('\n'), function (error) {
                            response.end(JSON.stringify({ status: 'success' }))
                        });
                    });
                }).catch(handleError.bind(null, response))

// find-peaks
            } else if (body.type === 'find-peaks') {
                getPopulationForSample(body.payload.workspaceId, body.payload.FCSFileId, body.payload.sampleId, body.payload.options).then((population) => {
                    const homology = new PersistentHomology(population, body.payload.options)
                    let percentageComplete = 0
                    homology.findPeaks((message) => {
                        // console.log({ jobId: jobId, type: 'loading-update', data: message })
                        // response.send({ jobId: jobId, type: 'loading-update', data: message })
                    }).then((data) => {
                        response.end(JSON.stringify(data))
                    })
                }).catch(handleError.bind(null, response))

// find-peaks-with-templates
            } else if (body.type === 'find-peaks-with-template') {
                getPopulationForSample(body.payload.workspaceId, body.payload.FCSFileId, body.payload.sampleId, body.payload.options).then((population) => {
                    const homology = new PersistentHomology(population, body.payload.options)
                    let percentageComplete = 0
                    homology.findPeaksWithTemplate((message) => {
                        // console.log({ jobId: jobId, type: 'loading-update', data: message })
                        // response.send({ jobId: jobId, type: 'loading-update', data: message })
                    }, body.payload.gateTemplates).then((data) => {
                        response.end(JSON.stringify(data))
                    })
                }).catch(handleError.bind(null, response))
                                
// get-expanded-gates
            } else if (body.type === 'get-expanded-gates') {
                getPopulationForSample(body.payload.workspaceId, body.payload.FCSFileId, body.payload.sampleId, body.payload.options).then((population) => {
                    const xOptions = _.clone(body.payload.options)
                    xOptions.knownPeaks = xOptions.sampleXChannelZeroPeaks
                    const xCutoffs = find1DPeaks(population.zeroDensityX.densityMap, population.maxDensity, xOptions)
                    
                    const yOptions = _.clone(body.payload.options)
                    yOptions.knownPeaks = xOptions.sampleYChannelZeroPeaks
                    const yCutoffs = find1DPeaks(population.zeroDensityY.densityMap, population.maxDensity, yOptions)

                    const expandedGates = expandToIncludeZeroes(xCutoffs, yCutoffs, body.payload.gates, body.payload.options)
                    response.end(JSON.stringify(expandedGates))
                }).catch(handleError.bind(null, response))

// get-included-events
            } else if (body.type === 'get-included-events') {
                getPopulationForSample(body.payload.workspaceId, body.payload.FCSFileId, body.payload.sampleId, body.payload.options).then((population) => {
                    const alteredGates = findIncludedEvents(population, body.payload.gates, body.payload.options)
                    response.end(JSON.stringify(alteredGates))
                }).catch(handleError.bind(null, response))

// save-new-subsample
            } else if (body.type === 'save-new-subsample') {
                getPopulationForSample(body.payload.workspaceId, body.payload.FCSFileId, body.payload.parentSampleId, body.payload.options).then((population) => {
                    const alteredGates = findIncludedEvents(population, [ body.payload.gate ], body.payload.options)
                    const directory = path.join(assetDirectory, 'workspaces', body.payload.workspaceId, body.payload.FCSFileId, body.payload.childSampleId)
                    mkdirp(directory, function (error) {
                        if (error) {
                            response.end(JSON.stringify({ status: constants.STATUS_FAIL, error }))
                        } else {
                            fs.writeFile(path.join(directory, 'include-event-ids.json'), JSON.stringify(alteredGates[0].includeEventIds), (error) => {
                                if (error) {
                                    response.end(JSON.stringify({ status: constants.STATUS_FAIL, error }))
                                } else {
                                    console.log(path.join(directory, 'include-event-ids.json'))
                                    response.end(JSON.stringify({ status: constants.STATUS_SUCCESS }))
                                }
                            })
                        }
                    });
                }).catch(handleError.bind(null, response))
            }
        })
    }).listen(3145);
}

process.on('disconnect', function() {
  console.log('parent exited')
  process.exit();
});