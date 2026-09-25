import { GfAdminImportSourceComponent } from '@ghostfolio/client/components/admin-import-source';
import { GfAdminPlatformComponent } from '@ghostfolio/client/components/admin-platform/admin-platform.component';
import { GfAdminTagComponent } from '@ghostfolio/client/components/admin-tag/admin-tag.component';
import { GfDataProviderStatusComponent } from '@ghostfolio/client/components/data-provider-status/data-provider-status.component';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import {
  DEFAULT_LOCALE,
  PROPERTY_API_KEY_GHOSTFOLIO
} from '@ghostfolio/common/config';
import { ConfirmationDialogType } from '@ghostfolio/common/enums';
import { getDateFormatString } from '@ghostfolio/common/helper';
import {
  DataProviderGhostfolioStatusResponse,
  DataProviderInfo,
  User
} from '@ghostfolio/common/interfaces';
import { GfEntityLogoComponent } from '@ghostfolio/ui/entity-logo';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { GfPremiumIndicatorComponent } from '@ghostfolio/ui/premium-indicator';
import { AdminService, DataService } from '@ghostfolio/ui/services';
import { GfValueComponent } from '@ghostfolio/ui/value';

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  OnInit,
  ViewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSort, MatSortModule } from '@angular/material/sort';
import { MatTableDataSource, MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterModule } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { ellipsisHorizontal, trashOutline } from 'ionicons/icons';
import { get } from 'lodash';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';
import { catchError, filter, of } from 'rxjs';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    GfAdminImportSourceComponent,
    GfAdminPlatformComponent,
    GfAdminTagComponent,
    GfDataProviderStatusComponent,
    GfEntityLogoComponent,
    GfPremiumIndicatorComponent,
    GfValueComponent,
    IonIcon,
    MatButtonModule,
    MatDialogModule,
    MatMenuModule,
    MatProgressBarModule,
    MatSortModule,
    MatTableModule,
    MatTooltipModule,
    NgxSkeletonLoaderModule,
    RouterModule
  ],
  selector: 'gf-admin-settings',
  styleUrls: ['./admin-settings.component.scss'],
  templateUrl: './admin-settings.component.html'
})
export class GfAdminSettingsComponent implements OnInit {
  @ViewChild(MatSort) sort: MatSort;

  public dataSource = new MatTableDataSource<DataProviderInfo>();
  public defaultDateFormat: string;
  public displayedColumns = [
    'icon',
    'name',
    'status',
    'assetProfileCount',
    'usage',
    'actions'
  ];
  public ghostfolioApiStatus: DataProviderGhostfolioStatusResponse;
  public readonly ghostfolioApiStatusTooltip = $localize`Additional requests are granted while you are setting up your instance`;
  public hasGhostfolioApiKey: boolean;
  public imageTag: string;
  public isEnriching = false;
  public isGhostfolioApiKeyValid: boolean;
  public isLoading = false;
  public user: User;

  protected readonly DEFAULT_LOCALE = DEFAULT_LOCALE;

  public constructor(
    private adminService: AdminService,
    private changeDetectorRef: ChangeDetectorRef,
    private dataService: DataService,
    private destroyRef: DestroyRef,
    private notificationService: NotificationService,
    private userService: UserService
  ) {
    addIcons({ ellipsisHorizontal, trashOutline });
  }

  public ngOnInit() {
    this.userService.stateChanged
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((state) => {
        if (state?.user) {
          this.user = state.user;

          this.defaultDateFormat = getDateFormatString(
            this.user.settings.locale
          );

          this.changeDetectorRef.markForCheck();
        }
      });

    this.initialize();
  }

  public isGhostfolioDataProvider(provider: DataProviderInfo): boolean {
    return provider.dataSource === 'GHOSTFOLIO';
  }

  public onEnrichFromSheet() {
    this.isEnriching = true;

    this.adminService
      .enrichFromSheet()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({
          matchedRowsCount,
          totalRowsCount,
          updatedProfilesCount
        }) => {
          this.isEnriching = false;
          this.changeDetectorRef.markForCheck();

          this.notificationService.alert({
            message: `Enriched ${updatedProfilesCount} asset profiles from ${matchedRowsCount} of ${totalRowsCount} sheet rows`,
            title: 'The icons, regions and sectors were updated'
          });
        },
        error: (error) => {
          this.isEnriching = false;
          this.changeDetectorRef.markForCheck();

          this.notificationService.alert({
            message: error?.error?.message ?? error?.message,
            title: 'Updating the icons, regions and sectors failed'
          });
        }
      });
  }

  public onRemoveGhostfolioApiKey() {
    this.notificationService.confirm({
      confirmFn: () => {
        this.dataService
          .putAdminSetting(PROPERTY_API_KEY_GHOSTFOLIO, { value: undefined })
          .subscribe(() => {
            this.initialize();
          });
      },
      confirmType: ConfirmationDialogType.Warn,
      title: $localize`Do you really want to delete the API key?`
    });
  }

  public onSetGhostfolioApiKey() {
    this.notificationService.prompt({
      confirmFn: (value) => {
        const ghostfolioApiKey = value?.trim();

        if (ghostfolioApiKey) {
          this.dataService
            .putAdminSetting(PROPERTY_API_KEY_GHOSTFOLIO, {
              value: ghostfolioApiKey
            })
            .subscribe(() => {
              this.initialize();
            });
        }
      },
      title: $localize`Please enter your Ghostfolio API key.`
    });
  }

  private initialize() {
    this.isLoading = true;

    this.dataSource = new MatTableDataSource();
    this.imageTag = (window as any).info?.imageTag;

    this.adminService
      .fetchAdminData()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ dataProviders, settings }) => {
        const filteredProviders = dataProviders.filter(({ dataSource }) => {
          return dataSource !== 'MANUAL';
        });

        this.dataSource = new MatTableDataSource(filteredProviders);
        this.dataSource.sort = this.sort;
        this.dataSource.sortingDataAccessor = get;

        const ghostfolioApiKey = settings[
          PROPERTY_API_KEY_GHOSTFOLIO
        ] as string;

        this.hasGhostfolioApiKey = !!ghostfolioApiKey;

        if (ghostfolioApiKey) {
          this.adminService
            .fetchGhostfolioDataProviderStatus(ghostfolioApiKey)
            .pipe(
              catchError(() => {
                this.isGhostfolioApiKeyValid = false;

                this.changeDetectorRef.markForCheck();

                return of(null);
              }),
              filter((status) => {
                return status !== null;
              }),
              takeUntilDestroyed(this.destroyRef)
            )
            .subscribe((status) => {
              this.ghostfolioApiStatus = status;
              this.isGhostfolioApiKeyValid = true;

              this.changeDetectorRef.markForCheck();
            });
        } else {
          this.isGhostfolioApiKeyValid = false;
        }

        this.isLoading = false;

        this.changeDetectorRef.markForCheck();
      });
  }
}
