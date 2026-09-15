import { useEffect } from "react";
import { Text, type ColorValue } from "react-native";
import { Tabs } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { start } from "../lib/socket";
import { useRig } from "../lib/store";
import { useColors } from "../lib/ui";

function Glyph({ glyph, color }: { glyph: string; color: ColorValue }) {
  return <Text style={{ color, fontSize: 18, lineHeight: 22 }}>{glyph}</Text>;
}

export default function RootLayout() {
  useEffect(() => {
    start();
  }, []);
  const p = useColors();
  const name = useRig((s) => s.brand.name);

  return (
    <>
      <StatusBar style="light" />
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: p.bg, borderBottomColor: p.border, borderBottomWidth: 1 },
          headerTitleStyle: { color: p.text, fontWeight: "600", fontSize: 16 },
          headerShadowVisible: false,
          headerTintColor: p.text,
          sceneStyle: { backgroundColor: p.bg },
          tabBarStyle: { backgroundColor: p.bg, borderTopColor: p.border, borderTopWidth: 1 },
          tabBarActiveTintColor: p.text,
          tabBarInactiveTintColor: p.muted,
          tabBarLabelStyle: { fontSize: 12 },
        }}
      >
        <Tabs.Screen name="index" options={{ title: name, tabBarLabel: "Dashboard", tabBarIcon: ({ color }) => <Glyph glyph="◉" color={color} /> }} />
        <Tabs.Screen name="events" options={{ title: "Events", tabBarIcon: ({ color }) => <Glyph glyph="≡" color={color} /> }} />
        <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: ({ color }) => <Glyph glyph="⚙" color={color} /> }} />
      </Tabs>
    </>
  );
}
