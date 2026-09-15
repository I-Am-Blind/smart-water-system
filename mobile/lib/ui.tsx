/**
 * Shared UI primitives following docs/DESIGN.md v2 (shadcn neutral, dark only):
 * near-black neutral surfaces, 1 px borders, radius 10, no shadows/gradients, sentence case,
 * tabular numerals. brand.colors.accent is used only for the master-flow reading while flowing
 * and the checked switch track; red/amber only as status signals; green only for the online dot.
 */
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { useRig } from "./store";

export interface Palette {
  bg: string; card: string; card2: string; border: string; text: string; muted: string;
  accent: string; ok: string; warn: string; danger: string;
}

export const RADIUS = 10;

export function useColors(): Palette {
  const accent = useRig((s) => s.brand.colors.accent);
  return {
    bg: "#0a0a0a",
    card: "#171717",
    card2: "#262626",
    border: "rgba(255,255,255,0.10)",
    text: "#fafafa",
    muted: "#a1a1a1",
    accent,
    ok: "#22c55e",
    warn: "#f59e0b",
    danger: "#ef4444",
  };
}

/** Flat card. With `title`, a 16 px semibold heading; `flush` removes inner padding so rows can use hairlines. */
export function Card({ title, description, children, style, flush }: {
  title?: string; description?: string; children: ReactNode; style?: ViewStyle; flush?: boolean;
}) {
  const p = useColors();
  return (
    <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }, style]}>
      {title ? (
        <View style={[styles.header, flush && styles.headerFlush]}>
          <Text style={{ color: p.text, fontSize: 16, fontWeight: "600" }}>{title}</Text>
          {description ? <Text style={{ color: p.muted, fontSize: 13, marginTop: 2 }}>{description}</Text> : null}
        </View>
      ) : null}
      <View style={flush ? undefined : styles.body}>{children}</View>
    </View>
  );
}

/** Section card as in the shadcn dashboard: muted label above a 24 px tabular number. */
export function Tile({ label, value, unit, color, note, children }: {
  label: string; value: string; unit?: string; color?: string; note?: string; children?: ReactNode;
}) {
  const p = useColors();
  return (
    <View style={[styles.card, styles.tile, { backgroundColor: p.card, borderColor: p.border }]}>
      <Text style={{ color: p.muted, fontSize: 13 }}>{label}</Text>
      <Text style={{ color: color ?? p.text, fontSize: 24, fontWeight: "600", fontVariant: ["tabular-nums"], lineHeight: 30 }}>
        {value}
        {unit ? <Text style={{ color: p.muted, fontSize: 13, fontWeight: "400" }}> {unit}</Text> : null}
      </Text>
      {note ? <Text style={{ color: p.muted, fontSize: 12, lineHeight: 16 }}>{note}</Text> : null}
      {children}
    </View>
  );
}

export function Hairline() {
  const p = useColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.border }} />;
}

export type BadgeVariant = "outline" | "destructive";

/** Status badge. Rendered only where a status is being reported. */
export function Badge({ text, variant = "outline", color }: { text: string; variant?: BadgeVariant; color?: string }) {
  const p = useColors();
  const destructive = variant === "destructive";
  return (
    <View style={[styles.badge, destructive ? { backgroundColor: p.danger, borderColor: p.danger } : { borderColor: p.border }]}>
      <Text style={{ color: destructive ? "#fafafa" : color ?? p.text, fontSize: 12, fontWeight: "500" }}>{text}</Text>
    </View>
  );
}

export type BtnVariant = "outline" | "ghost" | "destructive";

export function Btn({
  text, variant = "outline", onPress, disabled, busy, accessibilityLabel,
}: { text: string; variant?: BtnVariant; onPress: () => void; disabled?: boolean; busy?: boolean; accessibilityLabel?: string }) {
  const p = useColors();
  const bg = variant === "destructive" ? p.danger : variant === "outline" ? p.card : "transparent";
  const fg = variant === "destructive" ? "#fafafa" : p.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? text}
      style={({ pressed }) => [
        styles.btn,
        {
          backgroundColor: pressed && variant !== "destructive" ? p.card2 : bg,
          borderColor: variant === "outline" ? p.border : bg,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : <Text style={{ color: fg, fontSize: 13, fontWeight: "500" }}>{text}</Text>}
    </Pressable>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: RADIUS },
  header: { paddingHorizontal: 16, paddingTop: 14 },
  headerFlush: { paddingBottom: 12 },
  body: { padding: 16, gap: 10 },
  tile: { padding: 16, gap: 4, flexGrow: 1, flexBasis: "45%" },
  badge: { borderWidth: 1, borderRadius: RADIUS, paddingHorizontal: 8, paddingVertical: 2 },
  btn: { borderWidth: 1, borderRadius: RADIUS, paddingHorizontal: 12, height: 32, alignItems: "center", justifyContent: "center", minWidth: 72 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
});
