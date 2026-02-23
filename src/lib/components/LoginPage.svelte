<script lang="ts">
	import { login, logout } from '$lib/spotify/authorization';
	import { asset } from '$app/paths';
	import Main from './Main.svelte';
	import PermissionsSelector from './MultiSelector.svelte';
	import { is_logged_in, logged_in_guard } from '$lib/login';
	import { onMount } from 'svelte';
	import { getUser } from '$lib/spotify/api';

	const default_scopes = ['ugc-image-upload'];

	let permissions = $state([
		{
			scope: 'playlist-modify-public',
			label_data: 'public playlists - create & edit',
			value: false
		},
		{
			scope: 'playlist-read-private',
			label_data: 'private playlists - list & read',
			value: false
		},
		{
			scope: 'playlist-modify-private',
			label_data: 'private playlists - create & edit',
			value: false
		}
	]);

	let scopes = $derived(
		default_scopes.concat(...permissions.filter((p) => p.value).map((p) => p.scope))
	);

	let login_enabled = $derived(scopes.filter((p) => p.includes('modify')).length > 0);

	const logoutAndReset = () => {
		logout();
		$is_logged_in = Promise.resolve(false);
	};

	onMount(
		logged_in_guard(async () => {
			await getUser();
		})
	);
</script>

{#snippet label(data: string)}
	{data}
{/snippet}

<page>
	{#await $is_logged_in then is_logged_in}
		<content>
			{#if is_logged_in}
				<Main logout={logoutAndReset} />
			{:else}
				<login>
					<p>allow access to</p>
					<PermissionsSelector {label} bind:selections={permissions}></PermissionsSelector>
					<login-button>
						<button onclick={() => login(scopes)} disabled={!login_enabled}>
							<login-text> log in </login-text>
						</button>
					</login-button>
				</login>
				<footer>this website stores data in your browser to keep you logged in</footer>
			{/if}
			<footer>
				powered by
				<img src={asset('/spotify.svg')} alt="Spotify logo" />
			</footer>
		</content>
	{/await}
</page>

<style>
	content {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 95vh;
		padding: 2.5vh;
	}

	login {
		display: flex;
		flex-direction: column;
		flex-grow: 1;
		align-items: center;
		justify-content: center;
	}

	login-button {
		margin-top: 1em;
	}

	login-text {
		font-size: 1em;
		margin: 5em;
	}

	footer {
		margin-top: 1em;
		margin-bottom: 1em;
		font-size: 0.8em;
		max-width: 60%;
		text-align: center;
		flex-direction: row;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	footer img {
		margin-left: 0.5em;
		height: 1.5em;
	}
</style>
