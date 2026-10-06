import {
  CreateImportSourceDto,
  UpdateImportSourceDto
} from '@ghostfolio/common/dtos';
import { ConfirmationDialogType } from '@ghostfolio/common/enums';
import {
  ImportSource,
  AdminTinkoffSyncStatus
} from '@ghostfolio/common/interfaces';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { AdminService, DataService } from '@ghostfolio/ui/services';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  inject,
  input,
  OnInit,
  viewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatPaginator, MatPaginatorModule } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSort, MatSortModule } from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline,
  closeCircleOutline,
  createOutline,
  ellipsisHorizontal,
  shieldCheckmarkOutline,
  syncOutline,
  trashOutline
} from 'ionicons/icons';
import { get } from 'lodash';
import { DeviceDetectorService } from 'ngx-device-detector';
import { Subscription, switchMap, timer } from 'rxjs';

import { GfCreateOrUpdateImportSourceDialogComponent } from './create-or-update-import-source-dialog/create-or-update-import-source-dialog.component';
import { CreateOrUpdateImportSourceDialogParams } from './create-or-update-import-source-dialog/interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonIcon,
    MatButtonModule,
    MatDialogModule,
    MatMenuModule,
    MatPaginatorModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatSortModule,
    MatTableModule,
    RouterModule
  ],
  selector: 'gf-admin-import-source',
  styleUrls: ['./admin-import-source.component.scss'],
  templateUrl: './admin-import-source.component.html'
})
export class GfAdminImportSourceComponent implements OnInit {
  public readonly locale = input('ru');

  protected dataSource = new MatTableDataSource<ImportSource>();
  protected readonly displayedColumns = ['name', 'type', 'sync', 'actions'];
  protected readonly pageSize = 10;
  protected importSources: ImportSource[];
  protected syncStatusByImportSourceId: Record<string, AdminTinkoffSyncStatus> =
    {};

  private readonly paginator = viewChild.required(MatPaginator);
  private readonly sort = viewChild.required(MatSort);
  private readonly syncStatusSubscriptions = new Map<string, Subscription>();

  private readonly adminService = inject(AdminService);
  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dataService = inject(DataService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly deviceDetectorService = inject(DeviceDetectorService);
  private readonly dialog = inject(MatDialog);
  private readonly notificationService = inject(NotificationService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  public constructor() {
    addIcons({
      alertCircleOutline,
      closeCircleOutline,
      createOutline,
      ellipsisHorizontal,
      shieldCheckmarkOutline,
      syncOutline,
      trashOutline
    });
  }

  public ngOnInit() {
    this.fetchImportSources();

    this.destroyRef.onDestroy(() => {
      for (const subscription of this.syncStatusSubscriptions.values()) {
        subscription.unsubscribe();
      }

      this.syncStatusSubscriptions.clear();
    });

    this.route.queryParams
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        if (params['createImportSourceDialog']) {
          this.openCreateImportSourceDialog();
        } else if (params['editImportSourceDialog']) {
          if (this.importSources) {
            const importSource = this.importSources.find(({ id }) => {
              return id === params['importSourceId'];
            });

            if (importSource) {
              this.openUpdateImportSourceDialog(importSource);
            }
          } else {
            this.router.navigate(['.'], { relativeTo: this.route });
          }
        }
      });
  }

  protected onDeleteImportSource(aId: string) {
    this.notificationService.confirm({
      confirmFn: () => {
        this.deleteImportSource(aId);
      },
      confirmType: ConfirmationDialogType.Warn,
      title: $localize`Do you really want to delete this import source?`
    });
  }

  protected onUpdateImportSource({ id }: ImportSource) {
    this.router.navigate([], {
      queryParams: { editImportSourceDialog: true, importSourceId: id }
    });
  }

  protected onSyncImportSource(importSource: ImportSource): void {
    if (this.getSyncStatus(importSource.id)?.isRunning) {
      return;
    }

    this.adminService
      .syncImportSource(importSource.id, false)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (status) => {
          this.setSyncStatus(importSource.id, status);

          this.pollSyncStatus(importSource.id);
        },
        error: (error) => {
          this.notificationService.alert({
            message: error?.error?.message ?? error?.message,
            title: 'Sync failed'
          });
        }
      });
  }

  protected onTestImportSource(importSource: ImportSource): void {
    this.adminService
      .fetchImportSourceAccounts(importSource.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ accounts }) => {
          this.notificationService.alert({
            message: accounts
              .map(({ id, name, status }) => {
                return `${name} (${id}) — ${status}`;
              })
              .join(', '),
            title: 'Token is valid'
          });
        },
        error: (error) => {
          this.notificationService.alert({
            message: error?.error?.message ?? error?.message,
            title: 'Token check failed'
          });
        }
      });
  }

  private deleteImportSource(aId: string) {
    this.adminService
      .deleteImportSource(aId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.dataService.updateInfo();

          this.fetchImportSources();
        },
        error: (error) => {
          this.notificationService.alert({
            message: error?.error?.message ?? error?.message,
            title: 'Failed to delete import source'
          });
        }
      });
  }

  protected onDeleteImportedActivities(importSource: ImportSource) {
    const status = this.getSyncStatus(importSource.id);

    if (status?.isRunning) {
      return;
    }

    this.notificationService.confirm({
      confirmFn: () => {
        this.deleteImportedActivities(importSource.id);
      },
      confirmType: ConfirmationDialogType.Warn,
      title: $localize`Do you really want to delete the imported activities of "${importSource.name}"? The accounts of the import source are removed as well, so it can be synchronized again from scratch.`
    });
  }

  private deleteImportedActivities(id: string) {
    this.adminService
      .deleteImportSourceActivities(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ deletedAccountsCount, deletedActivitiesCount }) => {
          delete this.syncStatusByImportSourceId[id];

          this.dataService.updateInfo();

          this.notificationService.alert({
            message: `Deleted ${deletedActivitiesCount} activities in ${deletedAccountsCount} accounts`,
            title: 'Imported activities deleted'
          });

          this.fetchImportSources();
        },
        error: (error) => {
          this.notificationService.alert({
            message: error?.error?.message ?? error?.message,
            title: 'Failed to delete the imported activities'
          });
        }
      });
  }

  private getSyncStatus(id: string): AdminTinkoffSyncStatus {
    return this.syncStatusByImportSourceId[id];
  }

  protected getProgressValue(status: AdminTinkoffSyncStatus): number {
    if (!status.accountsCount) {
      return 0;
    }

    return Math.min(
      100,
      Math.round((100 * status.processedAccountsCount) / status.accountsCount)
    );
  }

  private pollSyncStatus(id: string) {
    this.syncStatusSubscriptions.get(id)?.unsubscribe();

    const subscription = timer(1000, 1000)
      .pipe(
        switchMap(() => {
          return this.adminService.fetchImportSourceSyncStatus(id);
        }),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe({
        next: (status) => {
          this.setSyncStatus(id, status);

          if (!status.isRunning) {
            this.syncStatusSubscriptions.get(id)?.unsubscribe();
            this.syncStatusSubscriptions.delete(id);

            this.onSyncFinished(status);
          }
        },
        error: () => {
          this.syncStatusSubscriptions.get(id)?.unsubscribe();
          this.syncStatusSubscriptions.delete(id);
        }
      });

    this.syncStatusSubscriptions.set(id, subscription);
  }

  private onSyncFinished(status: AdminTinkoffSyncStatus) {
    if (status.error) {
      this.notificationService.alert({
        message: status.error,
        title: 'Sync failed'
      });

      return;
    }

    const { result } = status;

    if (!result) {
      return;
    }

    this.notificationService.alert({
      message: [
        `Accounts: ${result.accountsCount}`,
        `Operations: ${result.totalOperationsCount}`,
        `Activities: ${result.activitiesCount}`,
        `Imported: ${result.importedActivitiesCount}`,
        `Duplicates: ${result.duplicateActivitiesCount}`,
        `Failed: ${result.failedActivitiesCount}`,
        `Skipped: ${result.skippedActivitiesCount}`
      ].join(', '),
      title: 'Sync completed'
    });

    this.dataService.updateInfo();
  }

  private setSyncStatus(id: string, status: AdminTinkoffSyncStatus) {
    this.syncStatusByImportSourceId[id] = status;

    this.changeDetectorRef.markForCheck();
  }

  private fetchImportSources() {
    this.adminService
      .fetchImportSources()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (importSources) => {
          this.importSources = importSources;

          this.dataSource = new MatTableDataSource(importSources);
          this.dataSource.paginator = this.paginator();
          this.dataSource.sort = this.sort();
          this.dataSource.sortingDataAccessor = get;

          this.dataService.updateInfo();

          this.changeDetectorRef.markForCheck();
        },
        error: (error) => {
          this.notificationService.alert({
            message: error?.error?.message ?? error?.message,
            title: 'Failed to load import sources'
          });
        }
      });
  }

  public openCreateImportSourceDialog() {
    const dialogRef = this.dialog.open<
      GfCreateOrUpdateImportSourceDialogComponent,
      CreateOrUpdateImportSourceDialogParams
    >(GfCreateOrUpdateImportSourceDialogComponent, {
      data: {} satisfies CreateOrUpdateImportSourceDialogParams,
      height: this.deviceType === 'mobile' ? '98vh' : undefined,
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((importSource: CreateImportSourceDto | null) => {
        if (importSource) {
          this.adminService
            .createImportSource(importSource)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: () => {
                this.dataService.updateInfo();

                this.fetchImportSources();
              },
              error: (error) => {
                this.notificationService.alert({
                  message: error?.error?.message ?? error?.message,
                  title: 'Failed to create import source'
                });
              }
            });
        }

        this.router.navigate(['.'], { relativeTo: this.route });
      });
  }

  private openUpdateImportSourceDialog({
    id,
    name,
    type,
    apiKey
  }: ImportSource) {
    const dialogRef = this.dialog.open<
      GfCreateOrUpdateImportSourceDialogComponent,
      CreateOrUpdateImportSourceDialogParams
    >(GfCreateOrUpdateImportSourceDialogComponent, {
      data: {
        importSource: {
          id,
          name,
          type,
          apiKey
        }
      } satisfies CreateOrUpdateImportSourceDialogParams,
      height: this.deviceType === 'mobile' ? '98vh' : undefined,
      width: this.deviceType === 'mobile' ? '100vw' : '50rem'
    });

    dialogRef
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((importSource: UpdateImportSourceDto | null) => {
        if (importSource) {
          this.adminService
            .updateImportSource(importSource.id!, importSource)
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe({
              next: () => {
                this.dataService.updateInfo();

                this.fetchImportSources();
              },
              error: (error) => {
                this.notificationService.alert({
                  message: error?.error?.message ?? error?.message,
                  title: 'Failed to update import source'
                });
              }
            });
        }

        this.router.navigate(['.'], { relativeTo: this.route });
      });
  }

  private get deviceType() {
    return this.deviceDetectorService.getDeviceInfo().deviceType;
  }
}
