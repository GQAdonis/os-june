import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HoverTip } from "../components/ui/HoverTip";

describe("HoverTip", () => {
  it("programmatically links the anchor to the tooltip", () => {
    render(
      <HoverTip tip="Private model with zero data retention." tabIndex={0}>
        Private mode
      </HoverTip>,
    );

    const anchor = screen.getByText("Private mode");
    fireEvent.focus(anchor);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Private model with zero data retention.");
    expect(anchor).toHaveAttribute("aria-describedby", tooltip.id);
  });

  it("preserves existing described-by references", () => {
    render(
      <>
        <span id="existing-help">Existing help</span>
        <HoverTip tip="Extra tooltip help." tabIndex={0} aria-describedby="existing-help">
          Unrestricted
        </HoverTip>
      </>,
    );

    const anchor = screen.getByText("Unrestricted");
    fireEvent.focus(anchor);

    const tooltip = screen.getByRole("tooltip");
    expect(anchor.getAttribute("aria-describedby")?.split(" ")).toEqual([
      "existing-help",
      tooltip.id,
    ]);
  });

  it("caps width to the passed value and reveals a positioned tip after the measure pass", () => {
    render(
      <HoverTip tip="Copied" compact width={104} tabIndex={0}>
        Copy
      </HoverTip>,
    );

    fireEvent.focus(screen.getByText("Copy"));

    const tooltip = screen.getByRole("tooltip");
    // width is a cap, not a fixed size, and the measure pass reveals the tip
    // rather than leaving it hidden.
    expect(tooltip.style.maxWidth).toBe("104px");
    expect(tooltip.style.width).toBe("");
    expect(tooltip).toHaveAttribute("data-state", "open");
    expect(tooltip.style.left).not.toBe("");
  });

  it("fades out on blur, then unmounts once the exit timer elapses", () => {
    vi.useFakeTimers();
    try {
      render(
        <HoverTip tip="Copied" compact tabIndex={0}>
          Copy
        </HoverTip>,
      );

      const anchor = screen.getByText("Copy");
      fireEvent.focus(anchor);
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-state", "open");

      fireEvent.blur(anchor);
      // Still mounted, now fading out.
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-state", "closing");

      act(() => {
        vi.runAllTimers();
      });
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the exit when the anchor is re-entered mid-fade", () => {
    vi.useFakeTimers();
    try {
      render(
        <HoverTip tip="Copied" compact tabIndex={0}>
          Copy
        </HoverTip>,
      );

      const anchor = screen.getByText("Copy");
      fireEvent.focus(anchor);
      fireEvent.blur(anchor);
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-state", "closing");

      fireEvent.focus(anchor);
      // Re-entry clears the close timer and re-asserts the open state.
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-state", "open");

      act(() => {
        vi.runAllTimers();
      });
      // The stale close timer must not tear down the re-opened tip.
      expect(screen.getByRole("tooltip")).toHaveAttribute("data-state", "open");
    } finally {
      vi.useRealTimers();
    }
  });
});
