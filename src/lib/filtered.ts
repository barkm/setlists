import { readJpegComment, writeJpegComment, removeDataUrlPrefix } from './jpeg/comment';
import { fetchImageData } from './jpeg/download';
import {
	addPlaylistCoverImage,
	changePlaylistDetails,
	createPlaylist,
	getPlaylist,
	getPlaylistCoverImage,
	getTracks,
	replaceTracks,
	type CoverImage,
	type Playlist,
	type Track
} from './spotify/api';
import type { MakeRequest } from './spotify/request';

export interface FilteredPlaylist {
	playlist: Playlist;
	expression: PlaylistNode;
	playlists: Map<string, Playlist>;
	updating: boolean;
}

export type PlaylistNode =
	| { type: 'playlist'; id: string }
	| { type: 'union'; operands: PlaylistNode[] }
	| { type: 'intersection'; operands: PlaylistNode[] }
	| { type: 'difference'; left: PlaylistNode; right: PlaylistNode };

// --- Stored definition types ---

type StoredLimits = { min: number | null; max: number | null };

type DefinitionV1 = {
	included_playlist_ids: string[];
	excluded_playlist_ids: string[];
	required_playlist_ids: string[];
	duration_limits?: StoredLimits;
	release_year_limits?: StoredLimits;
	required_artist_ids?: string[];
};

type DefinitionV2 = {
	version: 2;
	included_playlist_ids: string[];
	excluded_playlist_ids: string[];
	required_playlist_ids: string[];
	duration_limits: StoredLimits;
	release_year_limits: StoredLimits;
	required_artist_ids: string[];
};

type DefinitionV3 = {
	version: 3;
	expression: PlaylistNode;
	duration_limits: StoredLimits;
	release_year_limits: StoredLimits;
	required_artist_ids: string[];
};

type DefinitionV4 = {
	version: 4;
	expression: PlaylistNode;
};

type CurrentDefinition = DefinitionV4;

const idsToNode = (ids: string[]): PlaylistNode => {
	if (ids.length === 1) return { type: 'playlist', id: ids[0] };
	return { type: 'union', operands: ids.map((id) => ({ type: 'playlist', id })) };
};

const migrate = (raw: unknown): CurrentDefinition => {
	const def = raw as Record<string, unknown>;
	const version = (def.version as number) ?? 1;

	if (version === 1) {
		const v1 = def as DefinitionV1;
		return migrate({
			version: 2,
			included_playlist_ids: v1.included_playlist_ids,
			excluded_playlist_ids: v1.excluded_playlist_ids,
			required_playlist_ids: v1.required_playlist_ids,
			duration_limits: v1.duration_limits ?? { min: 0, max: null },
			release_year_limits: v1.release_year_limits ?? { min: null, max: null },
			required_artist_ids: v1.required_artist_ids ?? []
		} satisfies DefinitionV2);
	}

	if (version === 2) {
		const v2 = def as DefinitionV2;
		let expression: PlaylistNode = {
			type: 'difference',
			left: idsToNode(v2.included_playlist_ids),
			right: idsToNode(v2.excluded_playlist_ids)
		};
		if (v2.required_playlist_ids.length > 0) {
			expression = {
				type: 'intersection',
				operands: [expression, idsToNode(v2.required_playlist_ids)]
			};
		}
		return migrate({
			version: 3,
			expression,
			duration_limits: v2.duration_limits,
			release_year_limits: v2.release_year_limits,
			required_artist_ids: v2.required_artist_ids
		} satisfies DefinitionV3);
	}

	if (version === 3) {
		const v3 = def as DefinitionV3;
		return { version: 4, expression: v3.expression } satisfies DefinitionV4;
	}

	return def as CurrentDefinition;
};

const serializeDefinition = (expression: PlaylistNode): CurrentDefinition => ({
	version: 4,
	expression
});

export const collectPlaylistIds = (node: PlaylistNode): string[] => {
	switch (node.type) {
		case 'playlist':
			return [node.id];
		case 'union':
			return node.operands.flatMap(collectPlaylistIds);
		case 'intersection':
			return node.operands.flatMap(collectPlaylistIds);
		case 'difference':
			return [...collectPlaylistIds(node.left), ...collectPlaylistIds(node.right)];
	}
};

export const createFilteredPlaylist = async (
	make_request: MakeRequest,
	cover_data: string,
	name: string,
	expression: PlaylistNode,
	all_playlists: Playlist[],
	is_public: boolean
): Promise<FilteredPlaylist> => {
	const playlist = await createPlaylist(name, is_public, '');
	const referenced_ids = new Set(collectPlaylistIds(expression));
	const playlists = new Map(
		all_playlists.filter((p) => referenced_ids.has(p.id)).map((p) => [p.id, p])
	);
	return updateDefinition(make_request, cover_data, playlist, expression, playlists, is_public);
};

export const updateFilteredPlaylist = async (
	make_request: MakeRequest,
	filtered_playlist: FilteredPlaylist
): Promise<FilteredPlaylist> => {
	const cover_url = filtered_playlist.playlist.cover?.url;
	if (!cover_url) {
		throw new Error('Playlist has no cover');
	}
	const cover_data = await fetchImageData(cover_url);
	return updateDefinition(
		make_request,
		cover_data,
		filtered_playlist.playlist,
		filtered_playlist.expression,
		filtered_playlist.playlists,
		filtered_playlist.playlist.is_public
	);
};

const updateDefinition = async (
	make_request: MakeRequest,
	cover_data: string,
	playlist: Playlist,
	expression: PlaylistNode,
	playlists: Map<string, Playlist>,
	is_public: boolean
): Promise<FilteredPlaylist> => {
	changePlaylistDetails(playlist.id, is_public, make_request);
	const filtered_playlist: FilteredPlaylist = {
		playlist,
		expression,
		playlists,
		updating: false
	};
	const definition = serializeDefinition(expression);
	const cover = writeJpegComment(cover_data, JSON.stringify(definition));
	const cover_base64 = removeDataUrlPrefix(cover);
	let success = false;
	while (!success) {
		try {
			await addPlaylistCoverImage(playlist.id, cover_base64);
			success = true;
		} catch (error) {
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
	const tracks = await getAndFilterTracks(make_request, filtered_playlist);
	replaceTracks(
		playlist.id,
		tracks.map((track) => track.uri)
	);
	playlist.cover = await getCover(playlist.id);
	return filtered_playlist;
};

const getCover = async (playlist_id: string): Promise<CoverImage | undefined> => {
	let cover_url = undefined;
	let retries = 0;
	while (cover_url === undefined && retries < 5) {
		const cover = await getPlaylistCoverImage(playlist_id);
		if (cover && cover?.height === null) {
			cover_url = cover.url;
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
		retries++;
	}
	return cover_url
		? {
				url: cover_url,
				width: null,
				height: null
			}
		: undefined;
};

export const filterFilteredPlaylists = async (
	make_request: MakeRequest,
	playlists: Playlist[]
): Promise<FilteredPlaylist[]> => {
	const valid_playlists = await asyncFilter(playlists, isFilteredPlaylist);
	return await Promise.all(valid_playlists.map((p) => toFilteredPlaylist(make_request, p)));
};

const asyncFilter = async <T>(array: T[], filter: (x: T) => Promise<boolean>): Promise<T[]> => {
	const filter_array = await Promise.all(array.map(filter));
	return array.filter((_, i) => filter_array[i]);
};

const isFilteredPlaylist = async (playlist: Playlist): Promise<boolean> => {
	try {
		if (!playlist.cover || playlist.cover.width !== null || playlist.cover.height !== null) {
			return false;
		}
		const data_url = await fetchImageData(playlist.cover.url);
		const comment = readJpegComment(data_url);
		const raw = JSON.parse(comment.toString()) as Record<string, unknown>;
		const version = (raw.version as number | undefined) ?? 1;
		if (version <= 2) {
			if (
				!Array.isArray(raw.included_playlist_ids) ||
				!Array.isArray(raw.excluded_playlist_ids) ||
				!Array.isArray(raw.required_playlist_ids)
			) {
				return false;
			}
		} else {
			if (typeof raw.expression !== 'object' || raw.expression === null) {
				return false;
			}
		}
	} catch (error) {
		return false;
	}
	return true;
};

const toFilteredPlaylist = async (
	make_request: MakeRequest,
	playlist: Playlist
): Promise<FilteredPlaylist> => {
	if (!playlist.cover) {
		throw new Error('Playlist has no cover');
	}
	const dataUrl = await fetchImageData(playlist.cover.url);
	const comment = readJpegComment(dataUrl);
	const definition = migrate(JSON.parse(comment.toString()));
	const playlist_ids = [...new Set(collectPlaylistIds(definition.expression))];
	const playlist_entries = await Promise.all(
		playlist_ids.map(async (id) => [id, await getPlaylist(id, make_request)] as const)
	);
	const playlists = new Map(playlist_entries);
	return {
		playlist,
		expression: definition.expression,
		playlists,
		updating: false
	};
};

export const update = async (
	filtered_playlist: FilteredPlaylist,
	make_request: MakeRequest
): Promise<void> => {
	filtered_playlist.updating = true;
	const tracks = await getAndFilterTracks(make_request, filtered_playlist);
	replaceTracks(
		filtered_playlist.playlist.id,
		tracks.map((track) => track.uri)
	);
	filtered_playlist.updating = false;
};

const evaluateExpression = (
	node: PlaylistNode,
	tracksByPlaylist: Map<string, Track[]>
): Track[] => {
	switch (node.type) {
		case 'playlist':
			return tracksByPlaylist.get(node.id) ?? [];
		case 'union':
			return node.operands.flatMap((n) => evaluateExpression(n, tracksByPlaylist));
		case 'intersection': {
			if (node.operands.length === 0) return [];
			const [head, ...rest] = node.operands;
			return rest.reduce(
				(acc, n) => intersection(acc, evaluateExpression(n, tracksByPlaylist), (t) => t.uri),
				evaluateExpression(head, tracksByPlaylist)
			);
		}
		case 'difference':
			return difference(
				evaluateExpression(node.left, tracksByPlaylist),
				evaluateExpression(node.right, tracksByPlaylist),
				(t) => t.uri
			);
	}
};

const getAndFilterTracks = async (
	make_request: MakeRequest,
	filtered_playlist: FilteredPlaylist
): Promise<Track[]> => {
	const ids = [...new Set(collectPlaylistIds(filtered_playlist.expression))];
	const entries = await Promise.all(
		ids.map(async (id) => [id, await getTracks(id, make_request)] as const)
	);
	const tracksByPlaylist = new Map(entries);
	return evaluateExpression(filtered_playlist.expression, tracksByPlaylist);
};

export const getTracksFromPlaylists = async (
	make_request: MakeRequest,
	playlists: Playlist[]
): Promise<Track[]> => {
	const tracks = await Promise.all(
		playlists.map((playlist) => getTracks(playlist.id, make_request))
	);
	return tracks.flat();
};

const intersection = <T, S>(a: Array<T>, b: Array<T>, key: (x: T) => S): Array<T> => {
	const converted_b = new Set([...b].map(key));
	return [...a].filter((x) => converted_b.has(key(x)));
};

const difference = <T, S>(a: Array<T>, b: Array<T>, key: (x: T) => S): Array<T> => {
	const converted_b = new Set([...b].map(key));
	return [...a].filter((x) => !converted_b.has(key(x)));
};
