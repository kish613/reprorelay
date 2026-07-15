import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from "react";
import { createReproRelayClient, type ReproRelayClient, type ReproRelayOptions, type ReportDraft } from "@reprorelay/browser-sdk";

const ReproRelayContext = createContext<ReproRelayClient | null>(null);

export interface ReproRelayProviderProps extends PropsWithChildren {
  config: ReproRelayOptions;
}

export function ReproRelayProvider({ config, children }: ReproRelayProviderProps) {
  const [client, setClient] = useState<ReproRelayClient | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const nextClient = createReproRelayClient({ ...configRef.current, autoInjectButton: configRef.current.autoInjectButton ?? true });
    setClient(nextClient);
    return () => nextClient.destroy();
  }, []);

  return <ReproRelayContext.Provider value={client}>{children}</ReproRelayContext.Provider>;
}

export function useReproRelay(): ReproRelayClient {
  const client = useContext(ReproRelayContext);
  if (!client) throw new Error("useReproRelay must be used within ReproRelayProvider");
  return client;
}

export interface ReportIssueButtonProps {
  label?: string;
  className?: string;
}

export function ReportIssueButton({ label = "Report issue", className }: ReportIssueButtonProps) {
  const client = useContext(ReproRelayContext);
  return (
    <button type="button" className={className} disabled={!client} onClick={() => client?.show()}>
      {label}
    </button>
  );
}

export function useReportIssue() {
  const client = useReproRelay();
  return (draft: ReportDraft) => client.report(draft);
}
