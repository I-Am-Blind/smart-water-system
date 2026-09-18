import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { DEFAULT_MON, isMonitored, PUMP_UI_DUR_S, type Branch, type LeakLevel } from "../../packages/protocol/types";
import { ago, describeError, fmtLpm, LEAK_BADGE, since } from "../lib/format";
import { clearError, sendCmd, useRig } from "../lib/store";
import { Badge, Btn, Card, Hairline, Row, Tile, useColors } from "../lib/ui";

/** Alert.alert is a no-op on react-native-web, so use window.confirm there. */
function confirmAsync(title: string, message: string, okText: string): Promise<boolean> {
  if (Platform.OS === "web") {
    return Promise.resolve(typeof window !== "undefined" && window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: okText, onPress: () => resolve(true) },
    ]),
  );
}

/** Ticks once a second on its own so only the status line re-renders for the clock. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function StatusLine() {
  const p = useColors();
  const conn = useRig((s) => s.conn);
  const online = useRig((s) => s.online);
  const lastSeen = useRig((s) => s.lastSeen);
  const canControl = conn === "open" && online;
  const busyOff = useRig((s) => Object.values(s.pending).some((c) => c.act === "all_off"));
  const now = useNow();
  const text =
    conn !== "open"
      ? conn === "connecting" ? "Reconnecting to the server…" : "Not connected to the server"
      : online ? `Rig online, ${ago(lastSeen, now)}` : lastSeen ? `Rig offline since ${since(lastSeen)}` : "Waiting for the rig";
  return (
    <Row style={{ justifyContent: "space-between" }}>
      <Row>
        <View style={[styles.dot, { backgroundColor: canControl ? p.ok : p.muted }]} />
        <Text style={{ color: p.text, fontSize: 14 }}>{text}</Text>
      </Row>
      <Btn text="All off" variant="destructive" disabled={!canControl} busy={busyOff} onPress={() => sendCmd({ act: "all_off" })} />
    </Row>
  );
}

function OfflineNotice() {
  const p = useColors();
  const online = useRig((s) => s.online);
  const hasTel = useRig((s) => s.tel !== null);
  const lastSeen = useRig((s) => s.lastSeen);
  if (online || !hasTel || !lastSeen) return null;
  return (
    <View style={[styles.notice, { backgroundColor: p.card, borderColor: p.border }]}>
      <Text style={{ color: p.muted, fontSize: 13 }}>Rig offline since {since(lastSeen)}, showing the last reading.</Text>
    </View>
  );
}

function ErrorNotice() {
  const p = useColors();
  const err = useRig((s) => s.lastError);
  const branches = useRig((s) => s.brand.branches);
  useEffect(() => {
    if (!err) return;
    const t = setTimeout(clearError, 6000);
    return () => clearTimeout(t);
  }, [err]);
  if (!err) return null;
  return (
    <View style={[styles.notice, { backgroundColor: p.card, borderColor: p.danger }]}>
      <Text style={{ color: p.text, fontSize: 13 }}>{describeError(err.err, err.cmd, branches)}</Text>
    </View>
  );
}

/** Four section cards in a 2 x 2 grid, all values straight from the tel message. */
function Tiles() {
  const p = useColors();
  const name1 = useRig((s) => s.brand.branches[0]);
  const inflow = useRig((s) => s.tel?.f[0] ?? 0);
  const auto = useRig((s) => s.tel?.auto === 1);
  const lost = useRig((s) => s.tel?.loss[0] ?? 0);
  const ntu = useRig((s) => s.tel?.turb.ntu ?? 0);
  const ppm = useRig((s) => s.tel?.tds.ppm ?? 0);
  return (
    <View style={styles.grid}>
      <Tile label="Water in" value={fmtLpm(inflow)} unit="L/min" note={`entering ${name1}`} color={inflow > 0 ? p.accent : undefined} />
      <Tile label="Valve control" value={auto ? "Automatic" : "Manual"} note={auto ? "the rig switches branches on a leak" : "leaks are shown, you switch the valves"} />
      <Tile label="Water lost" value={lost.toFixed(1)} unit="%" note={`in/out difference on ${name1}`} />
      <Tile label="Turbidity / TDS" value={`${ntu}`} unit={`NTU, ${ppm} ppm`} note="clear water is under 5 NTU, drinking water is usually under 500 ppm" />
    </View>
  );
}

function BranchRow({ b, last }: { b: Branch; last: boolean }) {
  const p = useColors();
  const name = useRig((s) => s.brand.branches[b - 1]);
  // Only the monitored branch has meters, and `f` holds its IN/OUT pair. See docs/PROTOCOL.md §0.
  const sensed = useRig((s) => isMonitored(b, s.info?.mon ?? DEFAULT_MON));
  const inLpm = useRig((s) => s.tel?.f[0] ?? 0);
  const outLpm = useRig((s) => s.tel?.f[1] ?? 0);
  const loss = useRig((s) => s.tel?.loss[b - 1] ?? 0);
  const leak = useRig((s) => (s.tel?.leak[b - 1] ?? 0) as LeakLevel);
  const open = useRig((s) => s.tel?.v[b - 1] === 1);
  const auto = useRig((s) => s.tel?.auto === 1);
  const online = useRig((s) => s.conn === "open" && s.online);
  const busy = useRig((s) => Object.values(s.pending).some((c) => c.act === "valve" && c.b === b));
  const latched = leak >= 2;
  const disabled = !online || busy || auto;
  const hint = !online ? "Rig offline" : auto ? "Automatic mode: switch to manual to control the valves" : null;
  const lossText = !open
    ? latched && auto ? "closed by leak protection" : "valve closed"
    : sensed ? `loss ${loss.toFixed(1)} %`
    : "valve open";
  return (
    <>
      <View style={styles.branchRow}>
        <View style={{ flex: 1, gap: 3 }}>
          <Row>
            <Text style={{ color: p.text, fontSize: 14, fontWeight: "500" }}>{name}</Text>
            {leak === 1 ? <Badge text={LEAK_BADGE[1]} color={p.warn} /> : null}
            {latched ? <Badge text={LEAK_BADGE[leak]} variant="destructive" /> : null}
          </Row>
          {sensed ? (
            <Text style={[styles.nums, { color: p.text }]}>
              {fmtLpm(inLpm)} → {fmtLpm(outLpm)}
              <Text style={{ color: p.muted, fontSize: 13 }}> L/min</Text>
            </Text>
          ) : (
            <Text style={{ color: p.muted, fontSize: 13 }}>No flow meters on this branch</Text>
          )}
          <Text style={[styles.nums, { color: leak === 1 ? p.warn : p.muted, fontSize: 13 }]}>{lossText}</Text>
          {hint ? <Text style={{ color: p.muted, fontSize: 12 }}>{hint}</Text> : null}
        </View>
        <View style={{ alignItems: "center", gap: 4 }}>
          {busy ? <ActivityIndicator size="small" color={p.muted} /> : null}
          <Switch
            value={open}
            disabled={disabled}
            accessibilityLabel={open ? "Close valve" : "Open valve"}
            onValueChange={(v) => {
              sendCmd({ act: "valve", b, on: v });
            }}
            trackColor={{ true: p.accent, false: p.card2 }}
            thumbColor={p.text}
            ios_backgroundColor={p.card2}
          />
        </View>
      </View>
      {last ? null : <Hairline />}
    </>
  );
}

/** Automatic: the rig drives the valves. Manual: leaks are still reported, the operator drives them. */
function ModeRow() {
  const p = useColors();
  const auto = useRig((s) => s.tel?.auto === 1);
  const name1 = useRig((s) => s.brand.branches[0]);
  const name2 = useRig((s) => s.brand.branches[1]);
  const online = useRig((s) => s.conn === "open" && s.online);
  const busy = useRig((s) => Object.values(s.pending).some((c) => c.act === "auto" || c.act === "all_off"));
  return (
    <View style={styles.branchRow}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: p.text, fontSize: 14, fontWeight: "500" }}>Automatic mode</Text>
        <Text style={{ color: p.muted, fontSize: 13 }}>
          {auto
            ? `${name1} stays open, and ${name2} takes over if it leaks.`
            : "Leaks are still detected and shown. You open and close the valves."}
        </Text>
      </View>
      <View style={{ alignItems: "center", gap: 4 }}>
        {busy ? <ActivityIndicator size="small" color={p.muted} /> : null}
        <Switch
          value={auto}
          disabled={!online || busy}
          accessibilityLabel={auto ? "Switch to manual mode" : "Switch to automatic mode"}
          onValueChange={(v) => {
            sendCmd({ act: "auto", on: v });
          }}
          trackColor={{ true: p.accent, false: p.card2 }}
          thumbColor={p.text}
          ios_backgroundColor={p.card2}
        />
      </View>
    </View>
  );
}

function Branches() {
  const p = useColors();
  const pump = useRig((s) => s.tel?.pump === 1);
  const anyValveOpen = useRig((s) => (s.tel?.v ?? []).some((v) => v === 1));
  const anyLatched = useRig((s) => (s.tel?.leak ?? []).some((l) => l >= 2));
  const online = useRig((s) => s.conn === "open" && s.online);
  const busyPump = useRig((s) => Object.values(s.pending).some((c) => c.act === "pump"));
  const busyReset = useRig((s) => Object.values(s.pending).some((c) => c.act === "reset_leak"));

  const runPump = async () => {
    const ok = await confirmAsync(
      `Run pump for ${PUMP_UI_DUR_S / 60} minutes?`,
      "The pump stops by itself after 2 minutes or when the last valve closes.",
      "Run pump",
    );
    if (ok) sendCmd({ act: "pump", on: true, dur: PUMP_UI_DUR_S });
  };

  return (
    <Card title="Branches" flush>
      <Hairline />
      <ModeRow />
      <Hairline />
      <BranchRow b={1} last={false} />
      <BranchRow b={2} last />
      <Hairline />
      <View style={styles.footer}>
        {pump ? (
          <Btn text="Stop pump" disabled={!online} busy={busyPump} onPress={() => sendCmd({ act: "pump", on: false })} />
        ) : (
          <Btn text={`Run pump for ${PUMP_UI_DUR_S / 60} minutes`} disabled={!online || !anyValveOpen} busy={busyPump} onPress={() => void runPump()} />
        )}
        {anyLatched ? <Btn text="Clear leak" disabled={!online} busy={busyReset} onPress={() => sendCmd({ act: "reset_leak" })} /> : null}
        {!pump && !anyValveOpen ? <Text style={{ color: p.muted, fontSize: 12 }}>Open a valve first.</Text> : null}
      </View>
    </Card>
  );
}

export default function Dashboard() {
  const p = useColors();
  const hasTel = useRig((s) => s.tel !== null);
  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.content}>
      <StatusLine />
      <OfflineNotice />
      <ErrorNotice />
      {hasTel ? (
        <>
          <Tiles />
          <Branches />
        </>
      ) : (
        <Card>
          <Text style={{ color: p.muted, fontSize: 14, lineHeight: 20 }}>
            Waiting for the rig. Plug the Arduino into the laptop that runs the server.
          </Text>
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16, paddingBottom: 32 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  notice: { borderWidth: 1, borderRadius: 10, padding: 12 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  branchRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  footer: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap", paddingHorizontal: 16, paddingVertical: 12 },
  nums: { fontSize: 15, fontVariant: ["tabular-nums"] },
});
