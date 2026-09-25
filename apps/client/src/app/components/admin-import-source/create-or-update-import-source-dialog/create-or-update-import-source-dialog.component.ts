import { GfDialogFooterComponent } from '@ghostfolio/ui/dialog-footer';
import { GfDialogHeaderComponent } from '@ghostfolio/ui/dialog-header';
import { CreateImportSourceDto, UpdateImportSourceDto } from '@ghostfolio/common/dtos';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  inject
} from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MAT_DIALOG_DATA } from '@angular/material/dialog';

import { CreateOrUpdateImportSourceDialogParams } from './interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'd-flex flex-column h-100' },
  imports: [
    CommonModule,
    GfDialogFooterComponent,
    GfDialogHeaderComponent,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    ReactiveFormsModule
  ],
  selector: 'gf-create-or-update-import-source-dialog',
  styleUrls: ['./create-or-update-import-source-dialog.component.scss'],
  templateUrl: './create-or-update-import-source-dialog.component.html'
})
export class GfCreateOrUpdateImportSourceDialogComponent {
  protected readonly importSourceForm = new FormGroup({
    name: new FormControl<string | null>(null, { validators: [Validators.required] }),
    type: new FormControl<string | null>('T_INVEST', { validators: [Validators.required] }),
    apiKey: new FormControl<string | null>(null, { validators: [Validators.required] })
  });
  protected isLoading = false;

  private readonly dialogRef =
    inject<MatDialogRef<GfCreateOrUpdateImportSourceDialogComponent>>(MatDialogRef);
  protected readonly data = inject<CreateOrUpdateImportSourceDialogParams>(MAT_DIALOG_DATA);

  public ngOnInit() {
    if (this.data?.importSource) {
      this.importSourceForm.patchValue({
        name: this.data.importSource.name,
        type: this.data.importSource.type,
        apiKey: this.data.importSource.apiKey
      });
    }
  }

  protected onCancel() {
    this.dialogRef.close();
  }

  protected onSubmit() {
    if (this.importSourceForm.invalid) {
      return;
    }

    this.isLoading = true;

    const formValue = this.importSourceForm.value;

    if (this.data?.importSource) {
      const updateData: UpdateImportSourceDto = {
        id: this.data.importSource.id,
        name: formValue.name!,
        type: formValue.type!,
        apiKey: formValue.apiKey!
      };
      this.dialogRef.close(updateData);
    } else {
      const createData: CreateImportSourceDto = {
        name: formValue.name!,
        type: formValue.type!,
        apiKey: formValue.apiKey!
      };
      this.dialogRef.close(createData);
    }
  }

  protected getDialogTitle(): string {
    return this.data?.importSource
      ? 'Редактировать источник импорта'
      : 'Добавить источник импорта';
  }

  protected getSubmitButtonText(): string {
    return this.data?.importSource
      ? 'Сохранить'
      : 'Добавить';
  }
}