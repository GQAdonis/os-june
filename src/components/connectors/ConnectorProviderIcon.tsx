import { IconGoogle } from "central-icons/IconGoogle";
import { IconLinear } from "central-icons/IconLinear";
import { IconNotion } from "central-icons/IconNotion";
import type { ConnectorProvider } from "../../lib/tauri";

/** The monochrome brand mark for a connector provider (central-icons,
 * currentColor). Shared by the Connectors settings directory and the
 * approvals tray so provider identity renders the same everywhere. */
export function ConnectorProviderIcon({
  provider,
  size = 18,
}: {
  provider: ConnectorProvider;
  size?: number;
}) {
  if (provider === "notion") return <IconNotion size={size} aria-hidden />;
  if (provider === "linear") return <IconLinear size={size} aria-hidden />;
  return <IconGoogle size={size} aria-hidden />;
}
