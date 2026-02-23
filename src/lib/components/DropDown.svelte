<script lang="ts" generics="T extends {name: string}">
	import { MultiSelect } from 'svelte-multiselect';

	interface Props {
		placeholder: string;
		options: T[];
		selected: T[];
		option_snippet: (option: T) => any;
	}

	let { placeholder, options, selected = $bindable(), option_snippet }: Props = $props();

	const to_options = (ts: T[]) => {
		return ts.map((t) => ({
			label: t.name,
			value: t
		}));
	};

	let multiselect_options: { label: string; value: T }[] = $state(to_options(options));
	let multiselect_selected: { label: string; value: T }[] = $state(to_options(selected));

	$effect(() => {
		multiselect_options = to_options(options);
		multiselect_selected = to_options(selected);
	});
</script>

<MultiSelect
	{placeholder}
	options={multiselect_options}
	bind:selected={multiselect_selected}
	onchange={() => {
		selected = multiselect_selected.map((s) => s.value);
	}}
	onremoveAll={() => {
		selected = [];
		multiselect_selected = [];
	}}
>
	{#snippet children({ option })}
		{@render option_snippet(option.value)}
	{/snippet}
</MultiSelect>
