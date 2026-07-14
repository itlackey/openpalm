export function setBoundedMapEntry<K, V>(
	map: Map<K, V>,
	key: K,
	value: V,
	maxEntries: number
): void {
	if (!map.has(key) && map.size >= maxEntries) {
		const oldest = map.keys().next().value;
		if (oldest !== undefined) map.delete(oldest);
	}
	map.set(key, value);
}
