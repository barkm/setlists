<script lang="ts">
	import { type Artist, type Track } from '$lib/spotify/api';
	import { authorizedRequest } from '$lib/spotify/authorization';
	import {
		filterTracks,
		getTracksFromExpression,
		collectPlaylistIds,
		type PlaylistNode
	} from '$lib/filtered';
	import RangeSlider from 'svelte-range-slider-pips';
	import { ms_to_min_sec, type Limits } from '$lib/duration';
	import { logged_in_guard } from '$lib/login';
	import ArtistsDropDown from './ArtistsDropDown.svelte';

	interface Props {
		expression: PlaylistNode;
		duration_limits: Limits;
		release_year_limits: Limits;
		required_artists: Artist[];
	}

	let {
		expression,
		duration_limits = $bindable(),
		release_year_limits = $bindable(),
		required_artists = $bindable()
	}: Props = $props();

	const has_playlists = $derived(collectPlaylistIds(expression).length > 0);

	let raw_tracks = $derived(
		logged_in_guard(getTracksFromExpression)(authorizedRequest, expression)
	);

	const apply_filters = async (
		limits: Limits,
		year_limits: Limits,
		artists: Artist[]
	): Promise<Track[]> => {
		const tracks = await raw_tracks;
		if (tracks === undefined) return [];
		return filterTracks(tracks, [], [], limits, year_limits, artists);
	};

	let all_tracks = $derived.by(() =>
		apply_filters({ min: 0, max: Infinity }, { min: -Infinity, max: Infinity }, [])
	);

	let init_duration_limits = $derived.by(async () => {
		let tracks_resolved = await all_tracks;
		if (tracks_resolved.length === 0) {
			return { min: 0, max: 0 };
		}
		let durations = tracks_resolved.map((t) => t.duration_ms);
		return {
			min: Math.round(Math.min(...durations)) - 1,
			max: Math.round(Math.max(...durations)) + 1
		};
	});

	let init_release_year_limits = $derived.by(async () => {
		let tracks_resolved = await all_tracks;
		if (tracks_resolved.length === 0) {
			return { min: 0, max: 0 };
		}
		let release_years = tracks_resolved.map((t) => t.album.release_year);
		return {
			min: Math.min(...release_years) - 1,
			max: Math.max(...release_years) + 1
		};
	});

	let all_artists = $derived.by(async () => {
		let tracks_resolved = await all_tracks;
		if (tracks_resolved.length === 0) return [];
		let all_artists = tracks_resolved.map((t) => t.artists).flat();
		let unique_artist_ids = new Set();
		let unique_artists: Artist[] = [];
		for (let artist of all_artists) {
			if (!unique_artist_ids.has(artist.id)) {
				unique_artist_ids.add(artist.id);
				unique_artists.push(artist);
			}
		}
		return unique_artists.sort((a, b) => a.name.localeCompare(b.name));
	});

	let filtered_tracks = $derived.by(() =>
		apply_filters(duration_limits, release_year_limits, required_artists)
	);
</script>

<container>
	{#if has_playlists}
		{#await Promise.all([all_artists, init_duration_limits, init_release_year_limits])}
			<p>loading...</p>
		{:then [all_artists, init_duration_limits, init_release_year_limits]}
			<artists>
				<ArtistsDropDown artists={all_artists} bind:selected_artists={required_artists} />
			</artists>
			duration
			<range-slider>
				<RangeSlider
					id="always"
					float
					range
					hoverable={false}
					formatter={(ms) => {
						if (ms === init_duration_limits.min) {
							return '00:00';
						}
						if (ms === init_duration_limits.max) {
							return '+inf&nbsp;';
						}
						return ms_to_min_sec(ms);
					}}
					min={init_duration_limits.min}
					max={init_duration_limits.max}
					values={[duration_limits.min, duration_limits.max]}
					springValues={{ stiffness: 1, damping: 1 }}
					on:change={(e) => {
						const new_values = e.detail.values;
						duration_limits = {
							min: new_values[0] === init_duration_limits.min ? 0 : new_values[0],
							max: new_values[1] === init_duration_limits.max ? Infinity : new_values[1]
						};
					}}
				/>
			</range-slider>
			release year
			<range-slider>
				<RangeSlider
					id="always"
					float
					range
					hoverable={false}
					formatter={(year) => {
						if (year === init_release_year_limits.min) {
							return '-inf';
						}
						if (year === init_release_year_limits.max) {
							return '+inf';
						}
						return year.toString();
					}}
					min={init_release_year_limits.min}
					max={init_release_year_limits.max}
					values={[release_year_limits.min, release_year_limits.max]}
					springValues={{ stiffness: 1, damping: 1 }}
					on:change={(e) => {
						const new_values = e.detail.values;
						release_year_limits = {
							min: new_values[0] === init_release_year_limits.min ? -Infinity : new_values[0],
							max: new_values[1] === init_release_year_limits.max ? Infinity : new_values[1]
						};
					}}
				/>
			</range-slider>
		{/await}
		{#await filtered_tracks}
			<p>loading...</p>
		{:then filtered_tracks}
			<filtered-tracks>
				{#if filtered_tracks !== undefined}
					{#if filtered_tracks.length === 0}
						<p>No tracks</p>
					{:else}
						<p>{filtered_tracks.length} tracks found</p>
					{/if}
				{/if}
			</filtered-tracks>
		{/await}
	{/if}
</container>

<style>
	container {
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	artists {
		width: 100%;
	}

	range-slider {
		width: 60%;
		margin-top: 0.5em;
		margin-bottom: 1em;
	}

	:global(#always.rangeSlider) {
		border-radius: 0%;
		height: 0.25em;
	}

	:global(#always .rangeBar) {
		height: 0.25em;
	}

	:global(#always.rangeSlider .rangeHandle .rangeNub) {
		width: 3em;
		border-radius: 0%;
		padding: 0.5em;
		transform: translate(-1.5em, -0.55em);
		background-color: #ffffff;
		border: 1px solid #000000;
	}

	:global(#always .rangeFloat) {
		opacity: 1;
		transition: none;
		background: transparent;
		top: 50%;
		transform: translate(-2em, -50%);
		color: #000000;
		font-size: 1em;
	}

	:global(:root) {
		--range-slider: #d7dada;
		--range-handle-inactive: #000000;
		--range-handle: #ffffff;
		--range-handle-focus: #000000;
	}

	filtered-tracks {
		margin-top: 2em;
	}
</style>
