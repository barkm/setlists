<script lang="ts">
	import type { Playlist } from '$lib/spotify/api';
	import { authorizedRequest } from '$lib/spotify/authorization';
	import {
		update,
		updateFilteredPlaylist,
		collectPlaylistIds,
		type FilteredPlaylist,
		type PlaylistNode
	} from '$lib/filtered';
	import RandomSquare from './RandomSquare.svelte';

	interface Props {
		playlists: Playlist[];
		filtered_playlist: FilteredPlaylist;
		onRemove: () => void;
	}
	import { ms_to_min_sec, type Limits } from '$lib/duration';
	import { logged_in_guard } from '$lib/login';
	import ExpressionNode from './ExpressionNode.svelte';
	import PlaylistPrivacy from './PlaylistPrivacy.svelte';
	import TracksFilter from './TracksFilter.svelte';

	let { playlists, filtered_playlist = $bindable(), onRemove }: Props = $props();

	const get_duration_limit_str = (duration_limits: Limits) => {
		if (duration_limits.min === 0 && duration_limits.max === Infinity) {
			return '';
		}
		const min = ms_to_min_sec(duration_limits.min);
		const max = duration_limits.max === Infinity ? '+inf' : ms_to_min_sec(duration_limits.max);
		return `durations: ${min} - ${max}`;
	};

	const get_release_year_limit_str = (release_year_limits: Limits) => {
		if (release_year_limits.min === -Infinity && release_year_limits.max === Infinity) {
			return '';
		}
		const min = release_year_limits.min === -Infinity ? '-inf' : release_year_limits.min;
		const max = release_year_limits.max === Infinity ? '+inf' : release_year_limits.max;
		return `release years: ${min} - ${max}`;
	};

	const get_required_artists_str = () => {
		if (filtered_playlist.required_artists.length === 0) return '';
		return `artists: ${filtered_playlist.required_artists.map((a) => a.name).join(', ')}`;
	};

	let show_details = $state(false);
	let editing = $state(false);

	let edit_expression = $state<PlaylistNode>({ type: 'union', operands: [] });
	let edit_duration_limits = $state({ min: 0, max: Infinity });
	let edit_release_year_limits = $state({ min: -Infinity, max: Infinity });
	let edit_required_artists = $state(filtered_playlist.required_artists);

	const start_editing = () => {
		edit_expression = JSON.parse(JSON.stringify(filtered_playlist.expression));
		edit_duration_limits = { ...filtered_playlist.duration_limits };
		edit_release_year_limits = { ...filtered_playlist.release_year_limits };
		edit_required_artists = [...filtered_playlist.required_artists];
		editing = true;
	};

	const save = logged_in_guard(async () => {
		const referenced_ids = new Set(collectPlaylistIds(edit_expression));
		const updated_playlists = new Map(
			playlists.filter((p) => referenced_ids.has(p.id)).map((p) => [p.id, p])
		);
		filtered_playlist = {
			...filtered_playlist,
			expression: edit_expression,
			playlists: updated_playlists,
			duration_limits: edit_duration_limits,
			release_year_limits: edit_release_year_limits,
			required_artists: edit_required_artists
		};
		filtered_playlist = await updateFilteredPlaylist(authorizedRequest, filtered_playlist);
		editing = false;
	});
</script>

<container>
	<main>
		<a href={filtered_playlist.playlist.spotify_url} target="_blank">
			{#if filtered_playlist.updating}
				<RandomSquare update_ms={200} --height="100%" />
			{:else}
				<img src={filtered_playlist.playlist.cover?.url} alt="cover" />
			{/if}
		</a>
		<button class="playlistname" onclick={() => (show_details = !show_details)}>
			{filtered_playlist.playlist.name}
		</button>
	</main>

	{#if show_details}
		<playlistdetails>
			{#if editing}
				<PlaylistPrivacy bind:is_public={filtered_playlist.playlist.is_public} />
				<expression-editor>
					<ExpressionNode bind:node={edit_expression} {playlists} />
				</expression-editor>
				<TracksFilter
					expression={edit_expression}
					bind:duration_limits={edit_duration_limits}
					bind:release_year_limits={edit_release_year_limits}
					bind:required_artists={edit_required_artists}
				/>
				<buttons>
					<button class="click" disabled={filtered_playlist.updating} onclick={save}>done</button>
					<button
						class="click"
						disabled={filtered_playlist.updating}
						onclick={() => (editing = false)}>cancel</button
					>
				</buttons>
			{:else}
				<expression-editor>
					<ExpressionNode node={filtered_playlist.expression} {playlists} readonly />
				</expression-editor>
				{#if get_duration_limit_str(filtered_playlist.duration_limits) !== ''}
					<div>{get_duration_limit_str(filtered_playlist.duration_limits)}</div>
				{/if}
				{#if get_release_year_limit_str(filtered_playlist.release_year_limits) !== ''}
					<div>{get_release_year_limit_str(filtered_playlist.release_year_limits)}</div>
				{/if}
				{#if get_required_artists_str() !== ''}
					<div>{get_required_artists_str()}</div>
				{/if}
				<buttons>
					<button
						class="click"
						disabled={filtered_playlist.updating}
						onclick={logged_in_guard(() => update(filtered_playlist, authorizedRequest))}
						>update</button
					>
					<button class="click" disabled={filtered_playlist.updating} onclick={start_editing}
						>edit</button
					>
					<button
						class="click"
						disabled={filtered_playlist.updating}
						onclick={() => {
							if (confirm(`Remove playlist ${filtered_playlist.playlist.name}?`)) {
								onRemove();
							}
						}}>delete</button
					>
				</buttons>
			{/if}
		</playlistdetails>
	{/if}
</container>

<style>
	container {
		display: flex;
		flex-direction: column;
		align-items: center;
		width: 100%;
		margin-left: 5px;
		margin-right: 5px;
	}

	main {
		height: 2.5em;
		display: flex;
		flex-direction: row;
		border: 1px solid black;
		margin-top: 1em;
		padding: 0.5em;
		width: 100%;
	}

	a {
		align-self: center;
		height: 100%;
		flex-basis: auto;
		aspect-ratio: 1;
	}

	img {
		align-self: center;
		height: 100%;
	}

	.click {
		margin-left: 0.5em;
		align-self: center;
		font-size: 1em;
	}

	.playlistname {
		margin: 0;
		flex-grow: 1;
		align-self: center;
		background-color: transparent;
		border: none;
		text-align: left;
		font-size: 1em;
		color: black;
		padding: 0.5em;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	playlistdetails {
		display: flex;
		flex-direction: column;
		border-left: 1px solid black;
		border-right: 1px solid black;
		border-bottom: 1px solid black;
		margin-bottom: 5px;
		padding: 0.5em;
		max-width: 500px;
		width: 100%;
	}

	buttons {
		display: flex;
		flex-direction: row;
		margin-top: 1em;
	}

	expression-editor {
		display: block;
		width: 100%;
		margin-top: 1.5em;
		margin-bottom: 1.5em;
	}
</style>
