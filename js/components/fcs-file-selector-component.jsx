import React from 'react'
import { Component } from 'react'
import _ from 'lodash'
import Dropdown from '../lib/dropdown-inline.jsx'
import constants from '../lib/constants'
import MultipleSampleView from '../containers/multiple-sample-view-container.jsx'

export default class FCSFileSelector extends Component {
    
    constructor(props) {
        super(props)
        this.state = {}
    }

    selectFCSFile (FCSFileId) {
        this.refs['FCSFileDropdown'].getInstance().hideDropdown()
        this.props.api.selectFCSFile(FCSFileId, this.props.workspaceId)   
    }

    selectMachineType (FCSFileId, machineType) {
        this.refs['machineTypeDropdown'].getInstance().hideDropdown()
        this.props.api.updateFCSFile(FCSFileId, { machineType })
    }

    render () {
        let inner

        if (this.props.FCSFiles.length > 0) {
            let multipleSampleView
            if (this.props.selectedFCSFile && this.props.selectedSample) {
                multipleSampleView = <MultipleSampleView FCSFileId={this.props.selectedFCSFile.id} sampleId={this.props.selectedSample.id} />
            }

            const FCSFiles = this.props.FCSFiles.map((FCSFile) => {
                return {
                    value: FCSFile.title,
                    component: <div className='item' onClick={this.selectFCSFile.bind(this, FCSFile.id, this.props.workspaceId)} key={FCSFile.id}>{FCSFile.title}</div>
                }
            })

            const machineTypes = [
                {
                    key: constants.MACHINE_FLORESCENT,
                    label: 'Florescent'
                },
                {
                    key: constants.MACHINE_CYTOF,
                    label: 'Mass Cytometry'
                }
            ]

            const machineTypesRendered = machineTypes.map((machineType) => {
                return {
                    value: machineType.label,
                    component: <div className='item' onClick={this.selectMachineType.bind(this, this.props.selectedFCSFile.id, machineType.key)} key={machineType.key}>{machineType.label}</div>
                }
            })

            let machineTypeMessage
            if (this.props.selectedFCSFile && this.props.selectedFCSFile.machineType) {
                machineTypeMessage = 'File Name: ' + _.find(machineTypes, m => m.key === this.props.selectedFCSFile.machineType).label
            } else {
                machineTypeMessage = 'Loading...'
            }

            inner = (
                <div className='fcs-file-selector-inner'>
                    <div className='header'>
                        <div className='fcs-file-selector-dropdown'><Dropdown items={FCSFiles} textLabel={this.props.selectedFCSFile ? this.props.selectedFCSFile.title : 'Select FCSFile'} ref='FCSFileDropdown' /></div>
                        <div className='button delete' onClick={this.props.api.removeFCSFile.bind(null, this.props.selectedFCSFile.id)}><i className='lnr lnr-cross-circle'></i>Remove File From Workspace</div>
                        <div className='machine-type-selector-dropdown'><Dropdown items={machineTypesRendered} textLabel={machineTypeMessage} ref='machineTypeDropdown' /></div>
                        <div className='divider' />
                        <div className={'button jobs ' + (this.props.backgroundJobsEnabled ? 'enabled' : 'disabled')} onClick={this.props.api.setBackgroundJobsEnabled.bind(this, !this.props.backgroundJobsEnabled)}>
                            <i className='lnr lnr-cloud-sync'></i>Background Jobs {this.props.backgroundJobsEnabled ? 'Enabled' : 'Disabled'}
                        </div>
                    </div>
                    {multipleSampleView}
                </div>
            )
        } else {
            inner = (
                <div className='fcs-file-selector-inner empty'>
                    <div>Drag and drop FCS Files or use Use File -> Add to workspace to add an FCSFile.</div>
                </div>
            )
        }

        return (
            <div className='fcs-file-selector-outer'>
                {inner}
            </div>
        )
    }
}