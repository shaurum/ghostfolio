import { ImportSource } from '@ghostfolio/common/interfaces';

export interface CreateOrUpdateImportSourceDialogParams {
  importSource?: Pick<ImportSource, 'id' | 'name' | 'type' | 'apiKey'>;
}