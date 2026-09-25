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
import { MatSort, MatSortModule } from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { ConfirmationDialogType } from '@ghostfolio/common/enums';
import { ImportSource } from '@ghostfolio/common/interfaces';
import { CreateImportSourceDto, UpdateImportSourceDto } from '@ghostfolio/common/dtos';
import { get } from 'lodash';
import { DeviceDetectorService } from 'ngx-device-detector';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  createOutline,
  ellipsisHorizontal,
  syncOutline,
  trashOutline
} from 'ionicons/icons';

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
  protected readonly displayedColumns = [
    'name',
    'type',
    'actions'
  ];
  protected readonly pageSize = 10;
  protected importSources: ImportSource[];

  private readonly paginator = viewChild.required(MatPaginator);
  private readonly sort = viewChild.required(MatSort);

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
    addIcons({ createOutline, ellipsisHorizontal, syncOutline, trashOutline });
  }

  public ngOnInit() {
    this.fetchImportSources();

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

  protected onSyncImportSource(): void {
    // TODO: Implement sync for import source
    this.notificationService.alert({
      title: $localize`Sync not implemented yet`,
      message: $localize`Sync functionality for import sources is not implemented yet.`
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

  private fetchImportSources() {
    this.adminService
      .fetchImportSources()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((importSources) => {
        this.importSources = importSources;

        this.dataSource = new MatTableDataSource(importSources);
        this.dataSource.paginator = this.paginator();
        this.dataSource.sort = this.sort();
        this.dataSource.sortingDataAccessor = get;

        this.dataService.updateInfo();

        this.changeDetectorRef.markForCheck();
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

  private openUpdateImportSourceDialog({ id, name, type, apiKey }: ImportSource) {
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