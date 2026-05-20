"use client";

import { useState } from "react";
import { formatNumber } from "@/lib/format";

type PriceRangeVisualProps = {
  lowerExtendedPrice: number | null;
  lowerPrice: number | null;
  upperPrice: number | null;
  upperExtendedPrice: number | null;
  currentPrice: number | null;
  lowerLabel: string;
  currentLabel: string;
  upperLabel: string;
  rangeCount: number;
  markerPosition: number;
};

const VISUAL_HEIGHT = 72;
const LABEL_GAP = 18;
const LABEL_EDGE_PADDING = 7;

function priceFromPosition(position: number, lowerExtendedPrice: number, upperExtendedPrice: number) {
  return lowerExtendedPrice + (upperExtendedPrice - lowerExtendedPrice) * (position / 100);
}

function formatHoverPrice(price: number | null) {
  if (price === null || !Number.isFinite(price)) return "-";
  return `$${formatNumber(price, 2)}`;
}

function segmentTone(indexFromBottom: number, count: number) {
  if (count <= 2) return 0;
  const centerStart = Math.floor((count - 1) / 2);
  const centerEnd = Math.ceil((count - 1) / 2);
  return indexFromBottom < centerStart ? centerStart - indexFromBottom : indexFromBottom > centerEnd ? indexFromBottom - centerEnd : 0;
}

function topFromBottomPercent(bottomPercent: number) {
  return ((100 - bottomPercent) / 100) * VISUAL_HEIGHT;
}

function clampLabelTop(value: number) {
  return Math.min(VISUAL_HEIGHT - LABEL_EDGE_PADDING, Math.max(LABEL_EDGE_PADDING, value));
}

function currentLabelTop(currentTop: number, minTop: number, maxTop: number) {
  if (currentTop <= maxTop + LABEL_GAP) return clampLabelTop(maxTop + LABEL_GAP);
  if (currentTop >= minTop - LABEL_GAP) return clampLabelTop(minTop - LABEL_GAP);
  return clampLabelTop(currentTop);
}

export function PriceRangeVisual(props: PriceRangeVisualProps) {
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);
  const lowerExtendedPrice = props.lowerExtendedPrice;
  const upperExtendedPrice = props.upperExtendedPrice;
  const rangeCount = Math.max(1, Math.round(props.rangeCount));
  const greyPercent = 50 / (rangeCount + 1);
  const minLabelTop = clampLabelTop(topFromBottomPercent(greyPercent));
  const maxLabelTop = clampLabelTop(topFromBottomPercent(100 - greyPercent));
  const nowLabelTop = currentLabelTop(topFromBottomPercent(props.markerPosition), minLabelTop, maxLabelTop);
  const isCurrentHover =
    hoverPosition !== null && Math.abs(hoverPosition - props.markerPosition) <= 2 && props.currentPrice !== null;
  const hoverPrice =
    hoverPosition === null
      ? null
      : isCurrentHover
        ? props.currentPrice
        : lowerExtendedPrice !== null && upperExtendedPrice !== null
          ? priceFromPosition(hoverPosition, lowerExtendedPrice, upperExtendedPrice)
          : null;
  const isOutHover =
    hoverPrice !== null &&
    props.lowerPrice !== null &&
    props.upperPrice !== null &&
    (hoverPrice < props.lowerPrice || hoverPrice > props.upperPrice);
  const coloredSegments = Array.from({ length: rangeCount }, (_, index) => {
    const indexFromBottom = rangeCount - 1 - index;
    return (
      <span
        className={`range-segment range-green tone-${Math.min(segmentTone(indexFromBottom, rangeCount), 4)}`}
        key={indexFromBottom}
        style={{ gridRow: index + 2 }}
      />
    );
  });

  return (
    <div className="range-visual-layout">
      <div className="range-labels" aria-hidden="true">
        <span className="range-boundary-label" style={{ top: `${maxLabelTop}px` }}>
          {props.upperLabel}
        </span>
        <strong className="range-now-label" style={{ top: `${nowLabelTop}px` }}>
          {props.currentLabel}
        </strong>
        <span className="range-boundary-label" style={{ top: `${minLabelTop}px` }}>
          {props.lowerLabel}
        </span>
      </div>
      <div
        className="range-visual-wrap"
        aria-label="Price range"
        onMouseLeave={() => setHoverPosition(null)}
        onMouseMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setHoverPosition(Math.min(100, Math.max(0, ((bounds.bottom - event.clientY) / bounds.height) * 100)));
        }}
      >
        <div className="range-visual" style={{ gridTemplateRows: `0.5fr repeat(${rangeCount}, minmax(0, 1fr)) 0.5fr` }}>
          <span className="range-segment range-grey range-grey-top" />
          {coloredSegments}
          <span className="range-segment range-grey range-grey-bottom" />
        </div>
        {hoverPosition !== null ? (
          <span
            className={`range-hover-marker${isCurrentHover ? " is-current" : ""}${isOutHover ? " is-out" : ""}`}
            style={{ bottom: `${hoverPosition}%` }}
          >
            <span className="range-hover-label">{formatHoverPrice(hoverPrice)}</span>
          </span>
        ) : null}
        <span className="range-marker" style={{ bottom: `${props.markerPosition}%` }}>
          <span className="range-current-label">{formatHoverPrice(props.currentPrice)}</span>
        </span>
      </div>
    </div>
  );
}
