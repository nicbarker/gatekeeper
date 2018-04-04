// -------------------------------------------------------------
// A react-redux container for multiple-sample-view-outer-component.jsx.
// -------------------------------------------------------------

import { connect } from 'react-redux'
import { updateGate } from '../actions/gate-actions'
import { updateGateTemplate } from '../actions/gate-template-actions'
import constants from '../lib/constants'
import MultipleSampleView from '../components/sample-components/multiple-sample-view-component.jsx'
import _ from 'lodash'

const mapStateToProps = (state, ownProps) => {
    if (ownProps.sampleId) {
        // Find the selected sample
        const sample = _.find(state.samples, w => w.id === ownProps.sampleId) || {}
        const newSample = _.cloneDeep(sample)
        newSample.subSamples = []
        // If the workspace contains samples, find them and add them as complete objects
        if (newSample.subSampleIds) {
            for (let subSampleId of newSample.subSampleIds) {
                const subSample = _.find(state.samples, s => s.id === subSampleId)
                if (sample) { newSample.subSamples.push(subSample) }
            }
            
            newSample.subSampleIds = null
        }
        // Find the workspace that this sample is inside
        const workspace = _.find(state.workspaces, w => w.sampleIds.includes(ownProps.sampleId))

        newSample.sampleId = newSample.id

        // Find any gates on this sample
        const gates = []
        const gateTemplates = []
        for (let gate of state.gates) {
            if (gate.parentSampleId === ownProps.sampleId) {
                gates.push(gate)
                gateTemplates.push(_.find(state.gateTemplates, gt => gt.id === gate.gateTemplateId))
            }
        }

        // Find the parent sample if there is one
        const parent = _.find(state.samples, s => s.subSampleIds.includes(ownProps.sampleId))
        if (parent) {
            newSample.parentTitle = parent.title
            newSample.parentId = parent.id
        }

        // Find the gate template that created this sample
        const gateTemplate = _.find(state.gateTemplates, gt => gt.id === sample.gateTemplateId)

        // Find the gate template group that houses the corresponding gate template
        const gateTemplateGroup = _.find(state.gateTemplateGroups, g => g.childGateTemplateIds.includes(sample.gateTemplateId))
        let parentGateTitle
        if (gateTemplateGroup) {
            const parentGateTemplate = _.find(state.gateTemplates, gt => gt.id === gateTemplateGroup.parentGateTemplateId)
            if (!_.find(state.gateTemplateGroups, g => g.childGateTemplateIds.includes(parentGateTemplate.id))) {
                parentGateTitle = 'Root Gate'
            } else {
                parentGateTitle = parentGateTemplate.title
            }
        }

        newSample.selectedMachineType = newSample.selectedMachineType || constants.MACHINE_FLORESCENT

        return { api: state.api, workspace: workspace, sample: newSample, gates, gateTemplates, gateTemplate, gateTemplateGroup, parentGateTitle }
    } else {
        return { api: state.api, sample: { subSamples: [] }, gates: [] }
    }
}

const mapDispatchToProps = dispatch => {
    return {
        updateGateTemplate: (gateTemplateId, parameters) => {
            dispatch(updateGateTemplate(gateTemplateId, parameters))
        }
    }
}

const MultipleSampleViewWrapped = connect(
    mapStateToProps,
    mapDispatchToProps
)(MultipleSampleView)

export default MultipleSampleViewWrapped