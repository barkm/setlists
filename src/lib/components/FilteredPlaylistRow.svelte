<script lang="ts">
	import type { Artist, Playlist } from '$lib/spotify/api';
	import { authorizedRequest } from '$lib/spotify/authorization';
	import {
		update,
		updateFilteredPlaylist,
		buildSimpleExpression,
		getSimplePlaylists,
		type FilteredPlaylist
	} from '$lib/filtered';
	import RandomSquare from './RandomSquare.svelte';

	interface Props {
		playlists: Playlist[];
		filtered_playlist: FilteredPlaylist;
		onRemove: () => void;
	}
	import { ms_to_min_sec, type Limits } from '$lib/duration';
	import { logged_in_guard } from '$lib/login';
	import CreationOptions from './CreationOptions.svelte';

	let { playlists, filtered_playlist = $bindable(), onRemove }: Props = $props();

	const simple = $derived(
		getSimplePlaylists(filtered_playlist.expression, filtered_playlist.playlists)
	);

	const concat_playlist_names = (playlists: Playlist[]) => {
		return playlists.map((playlist) => playlist.name).join(', ');
	};

	const included_playlist_names = $derived(concat_playlist_names(simple.included));
	const excluded_playlist_names = $derived(concat_playlist_names(simple.excluded));
	const required_playlist_names = $derived(concat_playlist_names(simple.required));

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

	const get_required_artists_str = (required_artists: Artist[]) => {
		if (required_artists.length === 0) {
			return '';
		}
		return `artists: ${required_artists.map((artist) => artist.name).join(', ')}`;
	};

	const duration_limits = get_duration_limit_str(filtered_playlist.duration_limits);
	const release_year_limits = get_release_year_limit_str(filtered_playlist.release_year_limits);
	const required_artists = get_required_artists_str(filtered_playlist.required_artists);

	let show_details = $state(false);
	let editing = $state(false);

	let edit_included = $state<Playlist[]>([]);
	let edit_excluded = $state<Playlist[]>([]);
	let edit_required = $state<Playlist[]>([]);
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
				<CreationOptions
					{playlists}
					bind:included_playlists={edit_included}
					bind:excluded_playlists={edit_excluded}
					bind:required_playlists={edit_required}
					bind:is_public={filtered_playlist.playlist.is_public}
					bind:duration_limits={filtered_playlist.duration_limits}
					bind:release_year_limits={filtered_playlist.release_year_limits}
					bind:required_artists={filtered_playlist.required_artists}
				/>
				<buttons>
					<button
						class="click"
						disabled={filtered_playlist.updating}
						onclick={logged_in_guard(() => {
							filtered_playlist = {
								...filtered_playlist,
								expression: buildSimpleExpression(edit_included, edit_excluded, edit_required),
								playlists: new Map(
									[...edit_included, ...edit_excluded, ...edit_required].map((p) => [p.id, p])
								)
							};
							updateFilteredPlaylist(authorizedRequest, filtered_playlist)
								.then((s) => {
									filtered_playlist = s;
									editing = false;
								})
								.catch((e) => console.error(e));
						})}>done</button
					>
					<button
						class="click"
						disabled={filtered_playlist.updating}
						onclick={() => (editing = false)}>cancel</button
					>
				</buttons>
			{:else}
				{#if included_playlist_names !== ''}
					<div>
						included: {included_playlist_names}
					</div>
				{/if}
				{#if excluded_playlist_names !== ''}
					<div>
						excluded: {excluded_playlist_names}
					</div>
				{/if}
				{#if required_playlist_names !== ''}
					<div>
						required: {required_playlist_names}
					</div>
				{/if}
				{#if duration_limits !== ''}
					<div>
						{duration_limits}
					</div>
				{/if}
				{#if release_year_limits !== ''}
					<div>
						{release_year_limits}
					</div>
				{/if}
				{#if required_artists !== ''}
					<div>
						{required_artists}
					</div>
				{/if}

				<buttons>
					<button
						class="click"
						disabled={filtered_playlist.updating}
						onclick={logged_in_guard(() => update(filtered_playlist, authorizedRequest))}
						>update</button
					>
					<button
						class="click"
						disabled={filtered_playlist.updating}
						onclick={() => {
							const s = getSimplePlaylists(
								filtered_playlist.expression,
								filtered_playlist.playlists
							);
							edit_included = s.included;
							edit_excluded = s.excluded;
							edit_required = s.required;
							editing = true;
						}}>edit</button
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
</style>
