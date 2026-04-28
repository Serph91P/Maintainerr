import {
  CollectionVisibilitySettings,
  CreateCollectionParams,
  LibraryQueryOptions,
  MediaCollection,
  MediaItem,
  MediaItemType,
  MediaLibrary,
  MediaPlaylist,
  MediaServerFeature,
  MediaServerStatus,
  MediaServerType,
  MediaUser,
  PagedResult,
  RecentlyAddedOptions,
  UpdateCollectionParams,
  WatchRecord,
} from '@maintainerr/contracts';
import { forwardRef, Inject, Injectable } from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';
import { formatConnectionFailureMessage } from '../../../../utils/connection-error';
import { MaintainerrLogger } from '../../../logging/logs.service';
import { SettingsService } from '../../../settings/settings.service';
import { supportsFeature } from '../media-server.constants';
import type {
  IMediaServerService,
  MediaWatchState,
} from '../media-server.interface';

interface EmbySystemInfo {
  Id?: string;
  ServerName?: string;
  Version?: string;
  OperatingSystem?: string;
  WanAddress?: string;
}

interface EmbyUser {
  Id?: string;
  Name?: string;
  Policy?: {
    IsAdministrator?: boolean;
  };
  PrimaryImageTag?: string;
}

interface EmbyVirtualFolder {
  Name?: string;
  CollectionType?: string;
  ItemId?: string;
  Locations?: string[];
}

interface EmbyItemsResponse {
  Items?: EmbyItem[];
  TotalRecordCount?: number;
}

interface EmbyItem {
  Id?: string;
  Name?: string;
  Type?: string;
  DateCreated?: string;
  DateLastSaved?: string;
  Overview?: string;
  Path?: string;
  ParentId?: string;
  SeriesId?: string;
  SeasonId?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  RunTimeTicks?: number;
  CommunityRating?: number;
  OfficialRating?: string;
  ProviderIds?: Record<string, string | undefined>;
  UserData?: {
    PlayCount?: number;
    LastPlayedDate?: string;
    IsPlayed?: boolean;
  };
}

const EMBY_TICKS_PER_MS = 10000;

const normalizeEmbyType = (
  type: string | undefined,
): MediaItemType | undefined => {
  switch (type) {
    case 'Movie':
      return 'movie';
    case 'Series':
      return 'show';
    case 'Season':
      return 'season';
    case 'Episode':
      return 'episode';
    default:
      return undefined;
  }
};

const mapEmbyItem = (
  item: EmbyItem,
  libraryId: string,
  libraryTitle: string,
): MediaItem | undefined => {
  const type = normalizeEmbyType(item.Type);
  if (!item.Id || !item.Name || !type) {
    return undefined;
  }

  const providerIds = item.ProviderIds ?? {};

  return {
    id: item.Id,
    parentId: item.ParentId ?? item.SeasonId,
    grandparentId: item.SeriesId,
    title: item.Name,
    parentTitle: undefined,
    grandparentTitle: item.SeriesName,
    guid: item.Id,
    type,
    addedAt: item.DateCreated ? new Date(item.DateCreated) : new Date(),
    updatedAt: item.DateLastSaved ? new Date(item.DateLastSaved) : undefined,
    providerIds: {
      imdb: providerIds.Imdb ? [providerIds.Imdb] : undefined,
      tmdb: providerIds.Tmdb ? [providerIds.Tmdb] : undefined,
      tvdb: providerIds.Tvdb ? [providerIds.Tvdb] : undefined,
    },
    mediaSources: [],
    library: {
      id: libraryId,
      title: libraryTitle,
    },
    summary: item.Overview,
    viewCount: item.UserData?.PlayCount,
    lastViewedAt: item.UserData?.LastPlayedDate
      ? new Date(item.UserData.LastPlayedDate)
      : undefined,
    year: item.ProductionYear,
    durationMs: item.RunTimeTicks
      ? Math.floor(item.RunTimeTicks / EMBY_TICKS_PER_MS)
      : undefined,
    contentRating: item.OfficialRating,
    ratings: item.CommunityRating
      ? [
          {
            source: 'emby',
            value: item.CommunityRating,
          },
        ]
      : undefined,
    parentIndex: item.ParentIndexNumber,
    index: item.IndexNumber,
  };
};

@Injectable()
export class EmbyAdapterService implements IMediaServerService {
  private initialized = false;
  private baseUrl: string | undefined;
  private apiKey: string | undefined;
  private adminUserId: string | undefined;

  constructor(
    @Inject(forwardRef(() => SettingsService))
    private readonly settingsService: SettingsService,
    private readonly logger: MaintainerrLogger,
  ) {
    this.logger.setContext(EmbyAdapterService.name);
  }

  async initialize(): Promise<void> {
    const settings = await this.settingsService.getSettings();

    if (!settings || !('emby_url' in settings)) {
      throw new Error('Settings not available');
    }

    if (!settings.emby_url || !settings.emby_api_key) {
      throw new Error('Emby settings not configured');
    }

    this.baseUrl = settings.emby_url.replace(/\/+$/, '');
    this.apiKey = settings.emby_api_key;
    this.adminUserId = settings.emby_user_id ?? undefined;

    const status = await this.getStatus();
    if (!status) {
      this.uninitialize();
      throw new Error('Failed to connect to Emby');
    }

    this.initialized = true;
    this.logger.log(
      `Emby connection established: ${status.name ?? 'Emby'} (${status.version})`,
    );
  }

  uninitialize(): void {
    this.initialized = false;
    this.baseUrl = undefined;
    this.apiKey = undefined;
    this.adminUserId = undefined;
  }

  isSetup(): boolean {
    return this.initialized && Boolean(this.baseUrl && this.apiKey);
  }

  getServerType(): MediaServerType {
    return MediaServerType.EMBY;
  }

  supportsFeature(feature: MediaServerFeature): boolean {
    return supportsFeature(MediaServerType.EMBY, feature);
  }

  async getStatus(): Promise<MediaServerStatus | undefined> {
    try {
      const info = await this.get<EmbySystemInfo>('/emby/System/Info');
      if (!info?.Id || !info.Version) {
        return undefined;
      }

      return {
        machineId: info.Id,
        version: info.Version,
        name: info.ServerName,
        platform: info.OperatingSystem,
        url: this.baseUrl,
      };
    } catch (error) {
      this.logger.warn(
        formatConnectionFailureMessage(
          error,
          'Failed to query Emby system status.',
        ),
      );
      this.logger.debug(error);
      return undefined;
    }
  }

  async getUsers(): Promise<MediaUser[]> {
    try {
      const response = await this.get<{ Items?: EmbyUser[] } | EmbyUser[]>(
        '/emby/Users/Query',
      );
      const users = Array.isArray(response) ? response : (response.Items ?? []);

      return users
        .filter((user): user is EmbyUser & { Id: string; Name: string } =>
          Boolean(user?.Id && user?.Name),
        )
        .map((user) => ({
          id: user.Id,
          name: user.Name,
        }));
    } catch (error) {
      this.logger.warn('getUsers() - failed to fetch Emby users');
      this.logger.debug(error);
      return [];
    }
  }

  async getUser(id: string): Promise<MediaUser | undefined> {
    const users = await this.getUsers();
    return users.find((user) => user.id === id);
  }

  async getLibraries(): Promise<MediaLibrary[]> {
    try {
      const response = await this.get<{ Items?: EmbyVirtualFolder[] }>(
        '/emby/Library/VirtualFolders/Query',
      );
      const folders = response.Items ?? [];

      return folders
        .map((folder) => {
          const type =
            folder.CollectionType === 'movies'
              ? 'movie'
              : folder.CollectionType === 'tvshows'
                ? 'show'
                : undefined;

          if (!folder.ItemId || !folder.Name || !type) {
            return undefined;
          }

          return {
            id: folder.ItemId,
            title: folder.Name,
            type,
          } satisfies MediaLibrary;
        })
        .filter((library): library is MediaLibrary => library !== undefined);
    } catch (error) {
      this.logger.warn('getLibraries() - failed to fetch Emby libraries');
      this.logger.debug(error);
      return [];
    }
  }

  async getLibrariesStorage(): Promise<Map<string, number>> {
    return new Map();
  }

  async computeLibraryStorageSizes(): Promise<Map<string, number>> {
    return new Map();
  }

  async getLibraryContents(
    libraryId: string,
    options: LibraryQueryOptions = {},
  ): Promise<PagedResult<MediaItem>> {
    const library = (await this.getLibraries()).find((entry) => entry.id === libraryId);
    if (!library) {
      return { items: [], totalSize: 0, offset: options.offset ?? 0, limit: options.limit ?? 50 };
    }

    try {
      const response = await this.get<EmbyItemsResponse>(
        this.getItemsPath(),
        {
          ParentId: libraryId,
          Recursive: 'true',
          StartIndex: String(options.offset ?? 0),
          Limit: String(options.limit ?? 50),
          SearchTerm: undefined,
          IncludeItemTypes: this.toEmbyItemTypes(options.type),
        },
      );

      const items = (response.Items ?? [])
        .map((item) => mapEmbyItem(item, library.id, library.title))
        .filter((item): item is MediaItem => item !== undefined);

      return {
        items,
        totalSize: response.TotalRecordCount ?? items.length,
        offset: options.offset ?? 0,
        limit: options.limit ?? 50,
      };
    } catch (error) {
      this.logger.warn('getLibraryContents() - failed to fetch Emby library contents');
      this.logger.debug(error);
      return { items: [], totalSize: 0, offset: options.offset ?? 0, limit: options.limit ?? 50 };
    }
  }

  async getLibraryContentCount(
    libraryId: string,
    type?: MediaItemType,
  ): Promise<number> {
    const result = await this.getLibraryContents(libraryId, { offset: 0, limit: 1, type });
    return result.totalSize;
  }

  async searchLibraryContents(
    libraryId: string,
    query: string,
    type?: MediaItemType,
  ): Promise<MediaItem[]> {
    const library = (await this.getLibraries()).find((entry) => entry.id === libraryId);
    if (!library) {
      return [];
    }

    try {
      const response = await this.get<EmbyItemsResponse>(this.getItemsPath(), {
        ParentId: libraryId,
        Recursive: 'true',
        SearchTerm: query,
        IncludeItemTypes: this.toEmbyItemTypes(type),
        Limit: '50',
      });

      return (response.Items ?? [])
        .map((item) => mapEmbyItem(item, library.id, library.title))
        .filter((item): item is MediaItem => item !== undefined);
    } catch (error) {
      this.logger.warn('searchLibraryContents() - failed to search Emby library contents');
      this.logger.debug(error);
      return [];
    }
  }

  async getMetadata(itemId: string): Promise<MediaItem | undefined> {
    try {
      const item = await this.get<EmbyItem>(`${this.getItemsPath()}/${itemId}`);
      return mapEmbyItem(item, '', 'Unknown Library');
    } catch (error) {
      this.logger.warn(`getMetadata() - failed to fetch Emby item ${itemId}`);
      this.logger.debug(error);
      return undefined;
    }
  }

  async getChildrenMetadata(parentId: string): Promise<MediaItem[]> {
    try {
      const response = await this.get<EmbyItemsResponse>(this.getItemsPath(), {
        ParentId: parentId,
        Recursive: 'false',
      });

      return (response.Items ?? [])
        .map((item) => mapEmbyItem(item, '', 'Unknown Library'))
        .filter((item): item is MediaItem => item !== undefined);
    } catch (error) {
      this.logger.warn(`getChildrenMetadata() - failed to fetch Emby children for ${parentId}`);
      this.logger.debug(error);
      return [];
    }
  }

  async getRecentlyAdded(
    libraryId: string,
    options: RecentlyAddedOptions = {},
  ): Promise<MediaItem[]> {
    const result = await this.getLibraryContents(libraryId, {
      offset: 0,
      limit: options.limit ?? 50,
      type: options.type,
    });
    return result.items;
  }

  async searchContent(query: string): Promise<MediaItem[]> {
    try {
      const response = await this.get<EmbyItemsResponse>(this.getItemsPath(), {
        Recursive: 'true',
        SearchTerm: query,
        Limit: '50',
      });

      return (response.Items ?? [])
        .map((item) => mapEmbyItem(item, '', 'Unknown Library'))
        .filter((item): item is MediaItem => item !== undefined);
    } catch (error) {
      this.logger.warn('searchContent() - failed to search Emby content');
      this.logger.debug(error);
      return [];
    }
  }

  async getWatchHistory(_itemId: string): Promise<WatchRecord[]> {
    return [];
  }

  async getWatchState(
    itemId: string,
    nativeViewCount?: number,
  ): Promise<MediaWatchState> {
    const metadata = await this.getMetadata(itemId);
    const viewCount = metadata?.viewCount ?? nativeViewCount ?? 0;
    return {
      viewCount,
      isWatched: viewCount > 0,
    };
  }

  async getItemSeenBy(itemId: string): Promise<string[]> {
    const watchHistory = await this.getWatchHistory(itemId);
    return [...new Set(watchHistory.map((entry) => entry.userId))];
  }

  async getCollections(_libraryId: string): Promise<MediaCollection[]> {
    return [];
  }

  async getCollection(
    _collectionId: string,
    _throwOnError?: boolean,
  ): Promise<MediaCollection | undefined> {
    return undefined;
  }

  async createCollection(_params: CreateCollectionParams): Promise<MediaCollection> {
    throw new Error('Emby collection creation is not implemented yet');
  }

  async deleteCollection(_collectionId: string): Promise<void> {
    throw new Error('Emby collection deletion is not implemented yet');
  }

  async cleanupCollectionForLibrary(
    _collectionId: string,
    _libraryId: string,
    _isManualCollection: boolean,
  ): Promise<void> {
    throw new Error('Emby collection cleanup is not implemented yet');
  }

  async getCollectionChildren(_collectionId: string): Promise<MediaItem[]> {
    return [];
  }

  async addToCollection(_collectionId: string, _itemId: string): Promise<void> {
    throw new Error('Emby add-to-collection is not implemented yet');
  }

  async addBatchToCollection(
    _collectionId: string,
    itemIds: string[],
  ): Promise<string[]> {
    return itemIds;
  }

  async removeFromCollection(
    _collectionId: string,
    _itemId: string,
  ): Promise<void> {
    throw new Error('Emby remove-from-collection is not implemented yet');
  }

  async removeBatchFromCollection(
    _collectionId: string,
    itemIds: string[],
  ): Promise<string[]> {
    return itemIds;
  }

  async updateCollection(_params: UpdateCollectionParams): Promise<MediaCollection> {
    throw new Error('Emby collection updates are not implemented yet');
  }

  async updateCollectionVisibility(
    _settings: CollectionVisibilitySettings,
  ): Promise<void> {
    throw new Error('Emby collection visibility is not supported');
  }

  async getPlaylists(_libraryId: string): Promise<MediaPlaylist[]> {
    return [];
  }

  async deleteFromDisk(_itemId: string): Promise<void> {
    throw new Error('Emby delete-from-disk is not implemented yet');
  }

  async getAllIdsForContextAction(
    _collectionType: MediaItemType | undefined,
    _context: { type: MediaItemType; id: string },
    mediaId: string,
  ): Promise<string[]> {
    return [mediaId];
  }

  resetMetadataCache(_itemId?: string): void {}

  async refreshItemMetadata(_itemId: string): Promise<void> {
    throw new Error('Emby metadata refresh is not implemented yet');
  }

  private getItemsPath(): string {
    return this.adminUserId
      ? `/emby/Users/${this.adminUserId}/Items`
      : '/emby/Items';
  }

  private toEmbyItemTypes(type?: MediaItemType): string | undefined {
    switch (type) {
      case 'movie':
        return 'Movie';
      case 'show':
        return 'Series';
      case 'season':
        return 'Season';
      case 'episode':
        return 'Episode';
      default:
        return undefined;
    }
  }

  private async get<T>(
    path: string,
    params?: Record<string, string | undefined>,
  ): Promise<T> {
    if (!this.baseUrl || !this.apiKey) {
      throw new Error('Emby adapter is not initialized');
    }

    const config: AxiosRequestConfig = {
      headers: {
        'X-Emby-Token': this.apiKey,
        'Content-Type': 'application/json',
      },
      params,
    };

    const response = await axios.get<T>(`${this.baseUrl}${path}`, config);
    return response.data;
  }
}
