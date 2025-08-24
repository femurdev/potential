Frontend skeleton

This folder will contain a React/TypeScript graph editor. For now it's a placeholder and a suggested structure:

- src/
  - components/GraphEditor.tsx
  - components/NodePalette.tsx
  - App.tsx

The frontend should serialize graphs to the IR schema in ir/schema.json and send the JSON to the compiler backend (or run the CppEmitter locally in Node/Electron).
