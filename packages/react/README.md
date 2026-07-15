# @reprorelay/react

React provider for the [ReproRelay](https://github.com/kish613/reprorelay) bug-capture widget.

```tsx
import { ReproRelayProvider } from "@reprorelay/react";

export function App() {
  return (
    <ReproRelayProvider config={{ projectKey: "proj_your_project", apiUrl: "https://your-reprorelay.example.com" }}>
      <YourApp />
    </ReproRelayProvider>
  );
}
```

Licensed under the repository's [MIT License](https://github.com/kish613/reprorelay/blob/main/LICENSE). See the project notice for original-creator credit.
