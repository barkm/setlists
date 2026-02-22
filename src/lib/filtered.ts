import type { Limits } from './duration';
import { readJpegComment, writeJpegComment, removeDataUrlPrefix } from './jpeg/comment';
import { fetchImageData } from './jpeg/download';
import {
	addPlaylistCoverImage,
	changePlaylistDetails,
	createPlaylist,
	getArtists,
	getPlaylist,
	getPlaylistCoverImage,
	getTracks,
	replaceTracks,
	type Artist,
	type CoverImage,
	type Playlist,
	type Track
} from './spotify/api';
import type { MakeRequest } from './spotify/request';

export interface FilteredPlaylist {
	playlist: Playlist;
	expression: PlaylistNode;
	playlists: Map<string, Playlist>;
	duration_limits: Limits;
	release_year_limits: Limits;
	required_artists: Artist[];
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

type CurrentDefinition = DefinitionV3;

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

	return def as CurrentDefinition;
};

const serializeDefinition = (
	expression: PlaylistNode,
	duration_limits: Limits,
	release_year_limits: Limits,
	required_artists: Artist[]
): CurrentDefinition => ({
	version: 3,
	expression,
	duration_limits: {
		min: isFinite(duration_limits.min) ? duration_limits.min : null,
		max: isFinite(duration_limits.max) ? duration_limits.max : null
	},
	release_year_limits: {
		min: isFinite(release_year_limits.min) ? release_year_limits.min : null,
		max: isFinite(release_year_limits.max) ? release_year_limits.max : null
	},
	required_artist_ids: required_artists.map((a) => a.id)
});

const collectPlaylistIds = (node: PlaylistNode): string[] => {
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

// Builds the canonical simple expression from three playlist arrays.
export const buildSimpleExpression = (
	included: Playlist[],
	excluded: Playlist[],
	required: Playlist[]
): PlaylistNode => {
	let expression: PlaylistNode = idsToNode(included.map((p) => p.id));
	if (excluded.length > 0) {
		expression = {
			type: 'difference',
			left: expression,
			right: idsToNode(excluded.map((p) => p.id))
		};
	}
	if (required.length > 0) {
		expression = {
			type: 'intersection',
			operands: [expression, idsToNode(required.map((p) => p.id))]
		};
	}
	return expression;
};

// Extracts included/excluded/required playlist arrays from the canonical simple expression form.
// Falls back to showing all playlists as included for general expressions.
export const getSimplePlaylists = (
	expression: PlaylistNode,
	playlists: Map<string, Playlist>
): { included: Playlist[]; excluded: Playlist[]; required: Playlist[] } => {
	const lookup = (ids: string[]): Playlist[] =>
		ids.map((id) => playlists.get(id)).filter((p): p is Playlist => p !== undefined);

	const extractIds = (node: PlaylistNode): string[] => {
		if (node.type === 'playlist') return [node.id];
		if (node.type === 'union') return node.operands.flatMap(extractIds);
		return [];
	};

	// Canonical form with required: intersection([difference(union(incl), union(excl)), union(req)])
	if (expression.type === 'intersection' && expression.operands.length === 2) {
		const [first, second] = expression.operands;
		if (first.type === 'difference') {
			return {
				included: lookup(extractIds(first.left)),
				excluded: lookup(extractIds(first.right)),
				required: lookup(extractIds(second))
			};
		}
	}

	// Canonical form without required: difference(union(incl), union(excl))
	if (expression.type === 'difference') {
		return {
			included: lookup(extractIds(expression.left)),
			excluded: lookup(extractIds(expression.right)),
			required: []
		};
	}

	// Fallback: all as included
	return {
		included: lookup([...new Set(collectPlaylistIds(expression))]),
		excluded: [],
		required: []
	};
};

export const createFilteredPlaylist = async (
	make_request: MakeRequest,
	cover_data: string,
	name: string,
	included_playlists: Playlist[],
	excluded_playlists: Playlist[],
	required_playlists: Playlist[],
	is_public: boolean,
	duration_limits: Limits,
	release_year_limits: Limits,
	required_artists: Artist[]
): Promise<FilteredPlaylist> => {
	const playlist = await createPlaylist(name, is_public, '');
	const expression = buildSimpleExpression(
		included_playlists,
		excluded_playlists,
		required_playlists
	);
	const playlists = new Map(
		[...included_playlists, ...excluded_playlists, ...required_playlists].map((p) => [p.id, p])
	);
	return updateDefinition(
		make_request,
		cover_data,
		playlist,
		expression,
		playlists,
		is_public,
		duration_limits,
		release_year_limits,
		required_artists
	);
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
		filtered_playlist.playlist.is_public,
		filtered_playlist.duration_limits,
		filtered_playlist.release_year_limits,
		filtered_playlist.required_artists
	);
};

const updateDefinition = async (
	make_request: MakeRequest,
	cover_data: string,
	playlist: Playlist,
	expression: PlaylistNode,
	playlists: Map<string, Playlist>,
	is_public: boolean,
	duration_limits: Limits,
	release_year_limits: Limits,
	required_artists: Artist[]
): Promise<FilteredPlaylist> => {
	changePlaylistDetails(playlist.id, is_public, make_request);
	const filtered_playlist: FilteredPlaylist = {
		playlist,
		expression,
		playlists,
		duration_limits,
		release_year_limits,
		required_artists,
		updating: false
	};
	const definition = serializeDefinition(
		expression,
		duration_limits,
		release_year_limits,
		required_artists
	);
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
	const duration_limits = {
		min: definition.duration_limits.min ?? 0,
		max: definition.duration_limits.max ?? Infinity
	};
	const release_year_limits = {
		min: definition.release_year_limits.min ?? -Infinity,
		max: definition.release_year_limits.max ?? Infinity
	};
	const required_artists = await getArtists(definition.required_artist_ids, make_request);
	return {
		playlist,
		expression: definition.expression,
		playlists,
		duration_limits,
		release_year_limits,
		required_artists,
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
	const tracks = evaluateExpression(filtered_playlist.expression, tracksByPlaylist);
	return filterTracks(
		tracks,
		[],
		[],
		filtered_playlist.duration_limits,
		filtered_playlist.release_year_limits,
		filtered_playlist.required_artists
	);
};

export const filterTracks = (
	included_tracks: Track[],
	excluded_tracks: Track[],
	required_tracks: Track[],
	duration_limits: { min: number; max: number },
	release_year_limits: { min: number; max: number },
	required_artists: Artist[]
): Track[] => {
	let tracks = removeDuplicates(included_tracks, (track) => track.uri);
	tracks = tracks.filter((track) => {
		return track.duration_ms >= duration_limits.min && track.duration_ms <= duration_limits.max;
	});
	tracks = tracks.filter((track) => {
		return (
			track.album.release_year >= release_year_limits.min &&
			track.album.release_year <= release_year_limits.max
		);
	});
	let required_artists_set = new Set(required_artists.map((artist) => artist.id));
	if (required_artists_set.size > 0) {
		tracks = tracks.filter((track) => {
			return track.artists.some((artist) => required_artists_set.has(artist.id));
		});
	}
	tracks = difference(tracks, excluded_tracks, (track) => track.uri);
	if (required_tracks.length > 0) {
		tracks = intersection(tracks, required_tracks, (track) => track.uri);
	}
	return tracks;
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

const removeDuplicates = <T, S>(array: Array<T>, key: (x: T) => S): Array<T> => {
	const seen = new Set<S>();
	return array.filter((x) => {
		const k = key(x);
		return seen.has(k) ? false : seen.add(k);
	});
};

const intersection = <T, S>(a: Array<T>, b: Array<T>, key: (x: T) => S): Array<T> => {
	const converted_b = new Set([...b].map(key));
	return [...a].filter((x) => converted_b.has(key(x)));
};

const difference = <T, S>(a: Array<T>, b: Array<T>, key: (x: T) => S): Array<T> => {
	const converted_b = new Set([...b].map(key));
	return [...a].filter((x) => !converted_b.has(key(x)));
};
