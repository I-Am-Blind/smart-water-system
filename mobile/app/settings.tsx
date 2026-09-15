import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput } from "react-native";
import { PROTO_VERSION } from "../../packages/protocol/types";
import { getUrl, normalizeUrl, saveUrl } from "../lib/socket";
import { useRig } from "../lib/store";
import { Badge, Btn, Card, Row, useColors } from "../lib/ui";

export default function Settings() {
  const p = useColors();
  const conn = useRig((s) => s.conn);
  const serverUrl = useRig((s) => s.serverUrl);
  const info = useRig((s) => s.info);
  const deviceName = useRig((s) => s.brand.deviceName);
  const [draft, setDraft] = useState(getUrl());
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 3000);
    return () => clearTimeout(t);
  }, [saved]);

  const save = async (value: string) => {
    const u = await saveUrl(value);
    setDraft(u);
    setSaved(u);
  };

  const connText = conn === "open" ? "Connected" : conn === "connecting" ? "Reconnecting…" : "Disconnected";
  const suggested = serverUrl ? normalizeUrl(serverUrl) : null;

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={styles.content}>
      <Card title="Server" description="Address of the laptop or cloud server. Host and port is enough, for example 192.168.0.3:3000.">
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="ws://192.168.0.3:3000/ws"
          placeholderTextColor={p.muted}
          style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.bg }]}
          onSubmitEditing={() => void save(draft)}
        />
        <Row style={{ justifyContent: "space-between" }}>
          <Btn text="Save and connect" onPress={() => void save(draft)} />
          <Badge text={connText} color={conn === "open" ? p.text : p.muted} />
        </Row>
        {saved ? <Text style={{ color: p.muted, fontSize: 13 }}>Saved {saved}</Text> : null}
        {suggested && suggested !== getUrl() ? <Btn text="Use the server's address" variant="ghost" onPress={() => void save(suggested)} /> : null}
        {serverUrl ? <Text style={{ color: p.muted, fontSize: 13 }}>The server says it is reachable at {serverUrl}.</Text> : null}
      </Card>

      <Card title="Rig">
        {info ? (
          <>
            <Text style={{ color: p.text, fontSize: 14 }}>Device {info.id}</Text>
            <Text style={{ color: p.text, fontSize: 14 }}>IP {info.ip}</Text>
          </>
        ) : (
          <Text style={{ color: p.muted, fontSize: 14 }}>No rig has connected yet.</Text>
        )}
        <Text style={{ color: p.muted, fontSize: 13 }}>Local hostname {deviceName}.local. Protocol version {PROTO_VERSION}.</Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16, paddingBottom: 32 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
});
