"use client";

import { useState } from "react";
import { formatNumber } from "@/lib/format";

type PriceRangeVisualProps = {
  lowerPrice: number | null;
  upperPrice: number | null;
  currentPrice: number | null;
  markerPosition: number;
};

function priceFromPosition(position: number, lowerPrice: number, upperPrice: number) {
  return lowerPrice + (upperPrice - lowerPrice) * (position / 100);
}

function formatHoverPrice(price: number | null) {
  if (price === null || !Number.isFinite(price)) return "-";
  return `$${formatNumber(price, 2)}`;
}

export function PriceRangeVisual(props: PriceRangeVisualProps) {
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);
  const lowerPrice = props.lowerPrice;
  const upperPrice = props.upperPrice;
  const isCurrentHover =
    hoverPosition !== null && Math.abs(hoverPosition - props.markerPosition) <= 2 && props.currentPrice !== null;
  const hoverPrice =
    hoverPosition === null
      ? null
      : isCurrentHover
        ? props.currentPrice
        : lowerPrice !== null && upperPrice !== null
          ? priceFromPosition(hoverPosition, lowerPrice, upperPrice)
          : null;

  return (
    <div
      className="range-visual"
      aria-label="Price range"
      onMouseLeave={() => setHoverPosition(null)}
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        setHoverPosition(Math.min(100, Math.max(0, ((bounds.bottom - event.clientY) / bounds.height) * 100)));
      }}
    >
      <span className="range-segment range-low" />
      <span className="range-segment range-mid" />
      <span className="range-segment range-high" />
      {hoverPosition !== null ? (
        <span
          className={`range-hover-marker${isCurrentHover ? " is-current" : ""}`}
          style={{ bottom: `${hoverPosition}%` }}
        >
          <span className="range-hover-label">{formatHoverPrice(hoverPrice)}</span>
        </span>
      ) : null}
      <span className="range-marker" style={{ bottom: `${props.markerPosition}%` }}>
        <span className="range-current-label">{formatHoverPrice(props.currentPrice)}</span>
      </span>
    </div>
  );
}
