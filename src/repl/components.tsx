import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface MenuItem {
  label: string;
  hint?: string;
  value: string;
}

/** Suggestion list under the prompt (slash commands, @ mentions). */
export function Menu({ items, index }: { items: MenuItem[]; index: number }) {
  const start = Math.max(0, Math.min(index - 5, items.length - 12));
  const view = items.slice(start, start + 12);
  const w = Math.max(...view.map((i) => i.label.length), 8) + 2;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {view.map((it, k) => {
        const on = start + k === index;
        return (
          <Text key={it.value + k} color={on ? "cyan" : undefined}>
            {on ? "❯ " : "  "}
            {it.label.padEnd(w)}
            <Text color={on ? "cyan" : "gray"}>{it.hint ?? ""}</Text>
          </Text>
        );
      })}
      {items.length > view.length ? <Text color="gray">{`  … ${items.length - view.length}`}</Text> : null}
    </Box>
  );
}

/** Modal single select. */
export function Select({ title, items, initial = 0, onPick, hint }: { title: string; items: MenuItem[]; initial?: number; onPick: (v: string | undefined) => void; hint: string }) {
  const [i, setI] = useState(Math.min(initial, Math.max(0, items.length - 1)));
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) return onPick(undefined);
    if (key.upArrow || input === "k") setI((x) => (x - 1 + items.length) % items.length);
    else if (key.downArrow || input === "j") setI((x) => (x + 1) % items.length);
    else if (key.return) onPick(items[i]?.value);
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      <Menu items={items} index={i} />
      <Text color="gray">{`  ${hint}`}</Text>
    </Box>
  );
}

export interface EditorProps {
  value: string;
  cursor: number;
  placeholder?: string;
  prefix?: string;
  disabled?: boolean;
}

/** Renders the prompt with a visible cursor. Key handling lives in the App (it owns history and menus). */
export function Editor({ value, cursor, placeholder, prefix = "›", disabled }: EditorProps) {
  const lines = value.split("\n");
  let pos = cursor;
  return (
    <Box flexDirection="column">
      {value === "" ? (
        <Text>
          <Text bold color={disabled ? "gray" : "white"}>{`${prefix} `}</Text>
          {!disabled ? <Text inverse> </Text> : null}
          <Text color="gray">{placeholder ?? ""}</Text>
        </Text>
      ) : (
        lines.map((line, n) => {
          const here = pos >= 0 && pos <= line.length;
          const before = here ? line.slice(0, pos) : line;
          const at = here ? line.slice(pos, pos + 1) || " " : "";
          const after = here ? line.slice(pos + 1) : "";
          pos -= line.length + 1;
          return (
            <Text key={n}>
              <Text bold>{n === 0 ? `${prefix} ` : "  "}</Text>
              {before}
              {here && !disabled ? <Text inverse>{at}</Text> : at}
              {after}
            </Text>
          );
        })
      )}
    </Box>
  );
}

/** Pure editing operations on (value, cursor). */
export const edit = {
  insert(v: string, cur: number, s: string): [string, number] {
    return [v.slice(0, cur) + s + v.slice(cur), cur + s.length];
  },
  backspace(v: string, cur: number): [string, number] {
    if (cur === 0) return [v, 0];
    return [v.slice(0, cur - 1) + v.slice(cur), cur - 1];
  },
  del(v: string, cur: number): [string, number] {
    return [v.slice(0, cur) + v.slice(cur + 1), cur];
  },
  wordBack(v: string, cur: number): [string, number] {
    const left = v.slice(0, cur).replace(/\s*\S+\s*$/, "");
    return [left + v.slice(cur), left.length];
  },
  home(v: string, cur: number): number {
    return v.lastIndexOf("\n", cur - 1) + 1;
  },
  end(v: string, cur: number): number {
    const n = v.indexOf("\n", cur);
    return n < 0 ? v.length : n;
  },
};
