import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { NgbModule } from '@ng-bootstrap/ng-bootstrap';
import { TranslateModule } from '@ngx-translate/core';
import { NgxMdModule } from 'ngx-md';
import { Bootstrap4FrameworkModule } from '@oznu/ngx-bs4-jsonform';

import { CoreModule } from '../core.module';
import { ManagePluginsService } from './manage-plugins.service';
import { SettingsPluginsModalComponent } from './settings-plugins-modal/settings-plugins-modal.component';
import { ManagePluginsModalComponent } from './manage-plugins-modal/manage-plugins-modal.component';
import { CustomPluginsModule } from './custom-plugins/custom-plugins.module';

@NgModule({
  entryComponents: [
    SettingsPluginsModalComponent,
    ManagePluginsModalComponent,
  ],
  declarations: [
    SettingsPluginsModalComponent,
    ManagePluginsModalComponent,
  ],
  imports: [
    CommonModule,
    FormsModule,
    ReactiveFormsModule,
    TranslateModule.forChild(),
    NgbModule,
    NgxMdModule,
    Bootstrap4FrameworkModule,
    CoreModule,
    CustomPluginsModule,
  ],
  providers: [
    ManagePluginsService,
  ],
})
export class ManagePluginsModule { }
