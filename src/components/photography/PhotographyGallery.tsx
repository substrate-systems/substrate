"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { PhotographyImage } from "@/lib/photography";
import {
  adjacentImageIndices,
  boundedViewerIndex,
  swipeNavigationDirection,
  type ViewerDirection,
} from "./viewer-state";

type PhotographyGalleryProps = {
  images: readonly PhotographyImage[];
};

type GalleryRow = {
  entries: Array<{ image: PhotographyImage; index: number }>;
  isDiptych: boolean;
};

const focusableSelector = [
  "button:not([disabled])",
  "[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function galleryRows(images: readonly PhotographyImage[]): GalleryRow[] {
  const rows: GalleryRow[] = [];

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const canPair = image.pairWithNext === true && index + 1 < images.length;
    const entries = [{ image, index }];

    if (canPair) {
      entries.push({ image: images[index + 1], index: index + 1 });
      index += 1;
    }

    rows.push({ entries, isDiptych: canPair });
  }

  return rows;
}

export default function PhotographyGallery({ images }: PhotographyGalleryProps) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const pointerStartX = useRef<number | null>(null);
  const rows = useMemo(() => galleryRows(images), [images]);
  const total = images.length;
  const viewerIsOpen = activeIndex !== null;

  const closeViewer = useCallback(() => {
    setActiveIndex(null);
  }, []);

  const navigate = useCallback(
    (direction: Exclude<ViewerDirection, 0>) => {
      setActiveIndex((current) =>
        current === null ? null : boundedViewerIndex(current, direction, total)
      );
    },
    [total]
  );

  useEffect(() => {
    if (!viewerIsOpen) return;

    const modal = modalRef.current;
    const bodyChildren = Array.from(document.body.children).filter(
      (element) => element !== modal
    ) as HTMLElement[];
    const previousOverflow = document.body.style.overflow;
    const previousStates = bodyChildren.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    }));

    document.body.style.overflow = "hidden";
    for (const element of bodyChildren) {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    }

    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      for (const { element, inert, ariaHidden } of previousStates) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      window.requestAnimationFrame(() => openerRef.current?.focus());
    };
  }, [viewerIsOpen]);

  useEffect(() => {
    if (!viewerIsOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeViewer();
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigate(-1);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        navigate(1);
        return;
      }

      if (event.key !== "Tab" || !modalRef.current) return;
      const focusable = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>(focusableSelector)
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement;

      if (!modalRef.current.contains(activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [viewerIsOpen, closeViewer, navigate]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointerStartX.current = event.clientX;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (pointerStartX.current === null) return;
    const direction = swipeNavigationDirection(pointerStartX.current, event.clientX);
    pointerStartX.current = null;
    if (direction !== 0) navigate(direction);
  }

  const modal =
    activeIndex !== null
      ? createPortal(
          <div
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="photography-viewer-title"
            aria-describedby="photography-viewer-status"
            className="fixed inset-0 z-[1000] flex min-h-dvh flex-col bg-black/96 text-white"
          >
            <h2 id="photography-viewer-title" className="sr-only">
              Iceland Aurora image viewer
            </h2>

            <div className="relative z-10 flex min-h-16 items-center justify-between px-4 sm:px-6">
              <p
                id="photography-viewer-status"
                aria-live="polite"
                aria-atomic="true"
                className="text-xs tracking-[0.16em] text-white/55"
              >
                Image {activeIndex + 1} of {total}
              </p>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeViewer}
                aria-label="Close image viewer"
                className="flex min-h-11 min-w-11 items-center justify-center text-2xl font-light text-white/70 transition-colors hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white motion-reduce:transition-none"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            <div
              className="relative min-h-0 flex-1 touch-pan-y select-none overflow-hidden"
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                pointerStartX.current = null;
              }}
            >
              {adjacentImageIndices(activeIndex, total).map((index) => {
                const image = images[index];
                const isCurrent = index === activeIndex;
                return (
                  <div
                    key={image.id}
                    aria-hidden={!isCurrent}
                    className={`absolute inset-4 transition-opacity duration-300 sm:inset-8 motion-reduce:transition-none ${
                      isCurrent ? "opacity-100" : "pointer-events-none opacity-0"
                    }`}
                  >
                    <Image
                      src={image.src}
                      alt={isCurrent ? image.alt : ""}
                      fill
                      sizes="100vw"
                      className="object-contain"
                      draggable={false}
                      priority={isCurrent}
                    />
                  </div>
                );
              })}
            </div>

            <div className="relative z-10 flex min-h-20 items-center justify-between gap-4 px-4 sm:px-6">
              <button
                type="button"
                onClick={() => navigate(-1)}
                disabled={activeIndex === 0}
                aria-label="View previous image"
                className="min-h-11 min-w-11 px-3 text-left text-sm font-light text-white/70 transition-colors hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-default disabled:text-white/20 motion-reduce:transition-none"
              >
                ← Previous
              </button>
              <button
                type="button"
                onClick={() => navigate(1)}
                disabled={activeIndex === total - 1}
                aria-label="View next image"
                className="min-h-11 min-w-11 px-3 text-right text-sm font-light text-white/70 transition-colors hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-default disabled:text-white/20 motion-reduce:transition-none"
              >
                Next →
              </button>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <div className="mx-auto w-full max-w-[100rem] px-4 pb-28 sm:px-8 sm:pb-40 lg:px-12">
        {rows.map((row, rowIndex) => (
          <div
            key={row.entries[0].image.id}
            className={`${rowIndex === 0 ? "mt-0" : "mt-20 sm:mt-32 lg:mt-44"} ${
              row.isDiptych
                ? "grid gap-3 sm:grid-cols-2 sm:gap-5 lg:gap-7"
                : rowIndex % 3 === 1
                  ? "mx-auto max-w-[82rem]"
                  : "mx-auto max-w-[92rem]"
            }`}
          >
            {row.entries.map(({ image, index }) => (
              <figure key={image.id}>
                <button
                  type="button"
                  onClick={(event) => {
                    openerRef.current = event.currentTarget;
                    setActiveIndex(index);
                  }}
                  aria-label={`Open image ${index + 1} of ${total}: ${image.alt}`}
                  className="group block w-full cursor-zoom-in text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-white/70"
                >
                  <span
                    className="relative block w-full overflow-hidden bg-bg-surface"
                    style={{ aspectRatio: `${image.width} / ${image.height}` }}
                  >
                    <Image
                      src={image.src}
                      alt={image.alt}
                      fill
                      sizes={
                        row.isDiptych
                          ? "(min-width: 640px) 50vw, 100vw"
                          : "(min-width: 1600px) 1472px, 100vw"
                      }
                      className="object-cover transition-opacity duration-300 group-hover:opacity-90 motion-reduce:transition-none"
                      priority={index === 0}
                      loading={index === 0 ? "eager" : "lazy"}
                    />
                  </span>
                </button>
                {image.caption ? (
                  <figcaption className="mt-3 text-xs font-light text-fg-tertiary">
                    {image.caption}
                  </figcaption>
                ) : null}
              </figure>
            ))}
          </div>
        ))}
      </div>
      {modal}
    </>
  );
}
