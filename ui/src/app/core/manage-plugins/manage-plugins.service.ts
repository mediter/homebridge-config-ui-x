import { Injectable } from '@angular/core';
import { NgbModal } from '@ng-bootstrap/ng-bootstrap';

import { ManagePluginsModalComponent } from './manage-plugins-modal/manage-plugins-modal.component';
import { SettingsPluginsModalComponent } from './settings-plugins-modal/settings-plugins-modal.component';
import { CustomPluginsService } from './custom-plugins/custom-plugins.service';

@Injectable({
  providedIn: 'root',
})
export class ManagePluginsService {

  constructor(
    private modalService: NgbModal,
    private customPluginsService: CustomPluginsService,
  ) { }

  installPlugin(pluginName) {
    const ref = this.modalService.open(ManagePluginsModalComponent, {
      size: 'lg',
    });
    ref.componentInstance.action = 'Install';
    ref.componentInstance.pluginName = pluginName;
  }

  uninstallPlugin(pluginName) {
    const ref = this.modalService.open(ManagePluginsModalComponent, {
      size: 'lg',
    });
    ref.componentInstance.action = 'Uninstall';
    ref.componentInstance.pluginName = pluginName;
  }

  updatePlugin(pluginName) {
    const ref = this.modalService.open(ManagePluginsModalComponent, {
      size: 'lg',
    });
    ref.componentInstance.action = 'Update';
    ref.componentInstance.pluginName = pluginName;
  }

  upgradeHomebridge() {
    const ref = this.modalService.open(ManagePluginsModalComponent, {
      size: 'lg',
    });
    ref.componentInstance.action = 'Upgrade';
    ref.componentInstance.pluginName = 'homebridge';
  }

  settings(pluginName) {
    if (this.customPluginsService.plugins[pluginName]) {
      return this.customPluginsService.openSettings(pluginName);
    }

    const ref = this.modalService.open(SettingsPluginsModalComponent, {
      size: 'lg',
    });
    ref.componentInstance.pluginName = pluginName;
  }

}
