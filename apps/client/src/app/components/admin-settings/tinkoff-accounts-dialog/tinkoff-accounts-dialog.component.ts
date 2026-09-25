import { GfDialogHeaderComponent } from '@ghostfolio/ui/dialog-header';
import { AdminTinkoffAccountResponse } from '@ghostfolio/common/interfaces';

import {
  SelectionModel
} from '@angular/cdk/collections';
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  inject
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'd-flex flex-column h-100' },
  imports: [
    CommonModule,
    GfDialogHeaderComponent,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatTableModule,
    MatTooltipModule
  ],
  selector: 'gf-tinkoff-accounts-dialog',
  styleUrls: ['./tinkoff-accounts-dialog.component.scss'],
  templateUrl: './tinkoff-accounts-dialog.component.html'
})
export class GfTinkoffAccountsDialogComponent {
  protected accountsDataSource: MatTableDataSource<AdminTinkoffAccountResponse['accounts'][0]>;
  protected selectedAccounts = new SelectionModel<string>(true, []);
  protected isLoading = true;

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dialogRef =
    inject<MatDialogRef<GfTinkoffAccountsDialogComponent>>(MatDialogRef);
  private readonly data = inject<AdminTinkoffAccountResponse>(MAT_DIALOG_DATA);

  public ngOnInit() {
    this.loadAccounts();
  }

  protected onCancel() {
    this.dialogRef.close();
  }

  protected onConfirm() {
    const selectedIds = this.selectedAccounts.selected;
    this.dialogRef.close(selectedIds);
  }

  protected isAllSelected() {
    const numSelected = this.selectedAccounts.selected.length;
    const numRows = this.accountsDataSource?.data?.length ?? 0;
    return numSelected === numRows && numRows > 0;
  }

  protected isSomeSelected() {
    const numSelected = this.selectedAccounts.selected.length;
    const numRows = this.accountsDataSource?.data?.length ?? 0;
    return numSelected > 0 && numSelected < numRows;
  }

  protected toggleAll() {
    if (this.isAllSelected()) {
      this.selectedAccounts.clear();
    } else {
      this.accountsDataSource.data.forEach((account) => {
        this.selectedAccounts.select(account.id);
      });
    }
  }

  private loadAccounts() {
    this.accountsDataSource = new MatTableDataSource(this.data.accounts);
    this.selectedAccounts.clear();
    this.data.accounts.forEach((account) => this.selectedAccounts.select(account.id));
    this.isLoading = false;
    this.changeDetectorRef.markForCheck();
  }
}