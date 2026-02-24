<script lang="ts">
	import type { Playlist } from '$lib/spotify/api';
	import type { PlaylistNode } from '$lib/filtered';
	import ExpressionNode from './ExpressionNode.svelte';

	interface Props {
		node: PlaylistNode;
		playlists: Playlist[];
		readonly?: boolean;
		onremove?: () => void;
		onchange?: (newNode: PlaylistNode) => void;
	}

	let { node = $bindable(), playlists, readonly = false, onremove, onchange }: Props = $props();

	const setNode = (newNode: PlaylistNode) => {
		if (onchange) {
			onchange(newNode);
		} else {
			node = newNode;
		}
	};

	const empty_union = (): PlaylistNode => ({ type: 'union', operands: [] });
	const empty_playlist = (): PlaylistNode => ({ type: 'playlist', id: playlists[0]?.id ?? '' });

	type NaryType = 'union' | 'intersection';

	const playlist_from_nary = (old: { operands: PlaylistNode[] }): PlaylistNode =>
		old.operands.find((n) => n.type === 'playlist') ?? empty_playlist();

	const playlist_from_difference = (old: { left: PlaylistNode }): PlaylistNode =>
		old.left.type === 'playlist' ? old.left : empty_playlist();

	const nary_from_nary = (new_type: NaryType, old: { operands: PlaylistNode[] }): PlaylistNode =>
		({ type: new_type, operands: old.operands }) as PlaylistNode;

	const nary_from_difference = (
		new_type: NaryType,
		old: { left: PlaylistNode; right: PlaylistNode }
	): PlaylistNode => ({ type: new_type, operands: [old.left, old.right] }) as PlaylistNode;

	const nary_from_playlist = (new_type: NaryType, old: PlaylistNode): PlaylistNode =>
		({ type: new_type, operands: [old] }) as PlaylistNode;

	const difference_from_nary = (old: { operands: PlaylistNode[] }): PlaylistNode => {
		const [first, ...rest] = old.operands;
		return {
			type: 'difference',
			left: first ?? empty_union(),
			right: rest.length === 1 ? (rest[0] ?? empty_union()) : { type: 'union', operands: rest }
		};
	};

	const difference_from_other = (old: PlaylistNode): PlaylistNode => ({
		type: 'difference',
		left: old,
		right: empty_union()
	});

	const change_type = (new_type: PlaylistNode['type']) => {
		if (new_type === node.type) return;
		const old = node;
		if (new_type === 'playlist') {
			if (old.type === 'union' || old.type === 'intersection') {
				setNode(playlist_from_nary(old));
			} else if (old.type === 'difference') {
				setNode(playlist_from_difference(old));
			}
		} else if (new_type === 'union' || new_type === 'intersection') {
			if (old.type === 'union' || old.type === 'intersection') {
				setNode(nary_from_nary(new_type, old));
			} else if (old.type === 'difference') {
				setNode(nary_from_difference(new_type, old));
			} else {
				setNode(nary_from_playlist(new_type, old));
			}
		} else {
			if (old.type === 'union' || old.type === 'intersection') {
				setNode(difference_from_nary(old));
			} else {
				setNode(difference_from_other(old));
			}
		}
	};

	const add_child = () => {
		if (node.type === 'union' || node.type === 'intersection') {
			setNode({ ...node, operands: [...node.operands, empty_playlist()] } as PlaylistNode);
		}
	};

	const remove_child = (i: number) => {
		if (node.type === 'union' || node.type === 'intersection') {
			setNode({ ...node, operands: node.operands.filter((_, j) => j !== i) } as PlaylistNode);
		}
	};

	const playlist_name = $derived.by(() => {
		const n = node;
		if (n.type !== 'playlist') return '';
		return playlists.find((p) => p.id === n.id)?.name ?? n.id;
	});
</script>

<node-row>
	{#if readonly}
		<span class="type-label">{node.type}</span>
	{:else}
		<select
			value={node.type}
			onchange={(e) => change_type((e.target as HTMLSelectElement).value as PlaylistNode['type'])}
		>
			<option value="union">union</option>
			<option value="intersection">intersection</option>
			<option value="difference">difference</option>
			<option value="playlist">playlist</option>
		</select>
	{/if}

	{#if node.type === 'playlist'}
		{#if readonly}
			<span>{playlist_name}</span>
		{:else}
			<select
				class="playlist-select"
				value={node.id}
				onchange={(e) => {
					setNode({ type: 'playlist', id: (e.target as HTMLSelectElement).value });
				}}
			>
				{#each playlists as playlist}
					<option value={playlist.id}>{playlist.name}</option>
				{/each}
			</select>
		{/if}
	{:else if (node.type === 'union' || node.type === 'intersection') && !readonly}
		<button onclick={add_child}>+</button>
	{/if}

	{#if !readonly && onremove}
		<button onclick={onremove}>×</button>
	{/if}
</node-row>

{#if node.type === 'union' || node.type === 'intersection'}
	{@const operands = node.operands}
	<children>
		{#each operands as _, i}
			<ExpressionNode
				node={operands[i]}
				{playlists}
				{readonly}
				onremove={() => remove_child(i)}
				onchange={(newNode) =>
					setNode({
						...node,
						operands: operands.map((o, j) => (j === i ? newNode : o))
					} as PlaylistNode)}
			/>
		{/each}
	</children>
{:else if node.type === 'difference'}
	<children>
		<span class="diff-label">from</span>
		<ExpressionNode
			node={node.left}
			{playlists}
			{readonly}
			onchange={(newNode) => setNode({ ...node, left: newNode } as PlaylistNode)}
		/>
		<span class="diff-label">minus</span>
		<ExpressionNode
			node={node.right}
			{playlists}
			{readonly}
			onchange={(newNode) => setNode({ ...node, right: newNode } as PlaylistNode)}
		/>
	</children>
{/if}

<style>
	node-row {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: flex-start;
		gap: 0.4em;
		margin-top: 0.6em;
	}

	children {
		display: flex;
		flex-direction: column;
		margin-left: 1em;
		margin-top: 0.3em;
	}

	.type-label {
		font-style: italic;
	}

	.diff-label {
		color: #666;
		margin-top: 0.3em;
	}

	button {
		font: inherit;
		padding: 0.3em 0.7em;
		border-radius: 0;
		border: 1px solid black;
	}

	select {
		font: inherit;
		border-radius: 0;
		border: 1px solid black;
	}

	button {
		align-self: stretch;
	}

	.playlist-select {
		flex: 1;
		min-width: 0;
	}
</style>
