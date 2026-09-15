import { FlatList, StyleSheet, Text, View } from "react-native";
import type { RigEvent, Stamped } from "../../packages/protocol/types";
import { clock, describeEvent, eventTone } from "../lib/format";
import { useRig } from "../lib/store";
import { Hairline, useColors } from "../lib/ui";

function EventRow({ e }: { e: Stamped<RigEvent> }) {
  const p = useColors();
  const branches = useRig((s) => s.brand.branches);
  const tone = eventTone(e);
  const color = tone === "danger" ? p.danger : tone === "warn" ? p.warn : p.text;
  return (
    <View style={styles.row}>
      <Text style={[styles.time, { color: p.muted }]}>{clock(e.at)}</Text>
      <Text style={{ color, fontSize: 14, flex: 1, lineHeight: 20 }}>{describeEvent(e, branches)}</Text>
    </View>
  );
}

export default function Events() {
  const p = useColors();
  const events = useRig((s) => s.events);
  return (
    <FlatList
      style={{ backgroundColor: p.bg }}
      contentContainerStyle={styles.list}
      data={events}
      keyExtractor={(e) => `${e.at}-${e.ms}-${e.ev}`}
      renderItem={({ item }) => <EventRow e={item} />}
      ItemSeparatorComponent={Hairline}
      ListEmptyComponent={<Text style={{ color: p.muted, fontSize: 14, padding: 16 }}>Events from the rig will appear here.</Text>}
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingVertical: 4, paddingBottom: 32 },
  row: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 10, alignItems: "flex-start" },
  time: { fontSize: 13, fontVariant: ["tabular-nums"], width: 64, lineHeight: 20 },
});
