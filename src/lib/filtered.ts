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
	included_playlists: Playlist[];
	excluded_playlists: Playlist[];
	required_playlists: Playlist[];
	duration_limits: Limits;
	release_year_limits: Limits;
	required_artists: Artist[];
	updating: boolean;
}

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

type CurrentDefinition = DefinitionV2;

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

	return def as CurrentDefinition;
};

const serializeDefinition = (
	included_playlists: Playlist[],
	excluded_playlists: Playlist[],
	required_playlists: Playlist[],
	duration_limits: Limits,
	release_year_limits: Limits,
	required_artists: Artist[]
): CurrentDefinition => ({
	version: 2,
	included_playlist_ids: included_playlists.map((p) => p.id),
	excluded_playlist_ids: excluded_playlists.map((p) => p.id),
	required_playlist_ids: required_playlists.map((p) => p.id),
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
	return updateDefinition(
		make_request,
		cover_data,
		playlist,
		included_playlists,
		excluded_playlists,
		required_playlists,
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
		filtered_playlist.included_playlists,
		filtered_playlist.excluded_playlists,
		filtered_playlist.required_playlists,
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
	included_playlists: Playlist[],
	excluded_playlists: Playlist[],
	required_playlists: Playlist[],
	is_public: boolean,
	duration_limits: Limits,
	release_year_limits: Limits,
	required_artists: Artist[]
): Promise<FilteredPlaylist> => {
	changePlaylistDetails(playlist.id, is_public, make_request);
	const filtered_playlist: FilteredPlaylist = {
		playlist: playlist,
		included_playlists: included_playlists,
		excluded_playlists: excluded_playlists,
		required_playlists: required_playlists,
		duration_limits: duration_limits,
		release_year_limits: release_year_limits,
		required_artists: required_artists,
		updating: false
	};
	const definition = serializeDefinition(
		included_playlists,
		excluded_playlists,
		required_playlists,
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
		const definition = JSON.parse(comment.toString());
		if (
			!Array.isArray(definition.included_playlist_ids) ||
			!Array.isArray(definition.excluded_playlist_ids) ||
			!Array.isArray(definition.required_playlist_ids)
		) {
			return false;
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
	const included_playlists = await Promise.all(
		definition.included_playlist_ids.map((id: string) => getPlaylist(id, make_request))
	);
	const excluded_playlists = await Promise.all(
		definition.excluded_playlist_ids.map((id: string) => getPlaylist(id, make_request))
	);
	const required_playlists = await Promise.all(
		definition.required_playlist_ids.map((id: string) => getPlaylist(id, make_request))
	);
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
		playlist: playlist,
		included_playlists: included_playlists,
		excluded_playlists: excluded_playlists,
		required_playlists: required_playlists,
		duration_limits: duration_limits,
		release_year_limits: release_year_limits,
		required_artists: required_artists,
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

const getAndFilterTracks = async (
	make_request: MakeRequest,
	filtered_playlist: FilteredPlaylist
): Promise<Track[]> => {
	const included_tracks = await getTracksFromPlaylists(
		make_request,
		filtered_playlist.included_playlists
	);
	const excluded_tracks = await getTracksFromPlaylists(
		make_request,
		filtered_playlist.excluded_playlists
	);
	const required_tracks = await getTracksFromPlaylists(
		make_request,
		filtered_playlist.required_playlists
	);
	return filterTracks(
		included_tracks,
		excluded_tracks,
		required_tracks,
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
