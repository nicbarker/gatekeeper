// -------------------------------------------------------------
// A react.js component that renders the currently open
// workspace, including the side bar of samples and the main sample
// view.
// -------------------------------------------------------------

import React from 'react'
import ReactDOM from 'react-dom'
import { Component } from 'react'
import _ from 'lodash'
import '../scss/workspace-view.scss'
import SampleView from './sample-view.jsx'
import sessionHelper from './session-helper.js'

export default class WorkspaceView extends Component {

    constructor (props) {
        super(props)
        this.state = {
            selectedSampleId: this.props.selectedSampleId, // Can be undefined
            samples: this.props.samples
        }
    }

    selectSample (sampleId) {
        this.setState({
            selectedSampleId: sampleId
        }, () => { sessionHelper.saveSessionStateToDisk() })
    }

    removeSample (sampleId) {
        let sampleIndex = _.findIndex(this.state.samples, (sample) => {
            return sample.id === sampleId
        })

        if (sampleIndex === -1) { return }
        this.state.samples.splice(sampleIndex, 1)
        if (sampleIndex === this.state.samples.length) {
            sampleIndex--
        }
        // If there are still any samples left in the workspace, select the next one
        if (sampleIndex >= 0) {
            this.setState({
                samples: this.state.samples,
                selectedSampleId: this.state.samples[sampleIndex].id
            })
        }
    }

    updateCurrentSampleDataRepresentation (samples) {
        for (let i = 0; i < samples.length; i++) {
            let sample = samples[i]
            const sampleComponent = this.refs['sample-' + sample.id]
            if (sampleComponent) {
                samples[i] = sampleComponent.getDataRepresentation()
                return
            }

            if (sample.subSamples) {
                this.updateCurrentSampleDataRepresentation(sample.subSamples)
            }
        }
    }

    // Roll up the data that needs to be saved from this object and any children
    getDataRepresentation () {
        this.updateCurrentSampleDataRepresentation(this.state.samples)
        return {
            id: this.props.id,
            title: this.props.title,
            samples: this.state.samples,
            selectedSampleId: this.state.selectedSampleId
        }
    }

    renderSubSamples (sample) {
        if (sample.subSamples) {
            return sample.subSamples.map((subSample) => {
                return (
                    <div className={'sidebar-sample' + (subSample.id === this.state.selectedSampleId ? ' selected' : '')} key={subSample.id}>
                        <div className='body' onClick={this.selectSample.bind(this, subSample.id)}>
                            <div className='title'>{subSample.title}</div>
                            <div className='description'>{subSample.description}</div>
                        </div>
                        <div className='sub-samples'>{this.renderSubSamples(subSample)}</div>
                    </div>
                )
            })
        }
    }

    findSampleById (samples, id) {
        for (let sample of samples) {
            if (sample.id === id) { return sample }

            if (sample.subSamples) {
                const found = this.findSampleById(sample.subSamples, id)
                if (found) { return found }
            }
        }
    }

    render () {
        const workspacesSamplesRendered = this.state.samples.map((sample) => {
            return (
                <div className={'sidebar-sample' + (sample.id === this.state.selectedSampleId ? ' selected' : '')} key={sample.id}>
                    <div className='body' onClick={this.selectSample.bind(this, sample.id)}>
                        <div className='title'>{sample.title}</div>
                        <div className='description'>{sample.description}</div>
                    </div>
                    <div className='sub-samples'>{this.renderSubSamples(sample)}</div>
                </div>
            )
        })

        const sample = this.findSampleById(this.state.samples, this.state.selectedSampleId)

        let panel = <div className='panel'></div>

        if (sample) {
            panel = <SampleView ref={'sample-' + sample.id} {...sample} />
        }
        return (
            <div className='workspace'>
                <div className='sidebar'>
                    {workspacesSamplesRendered}
                </div>
                {panel}
            </div>
        )
    }
}