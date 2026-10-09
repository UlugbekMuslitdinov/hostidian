import { useContext, type KeyboardEvent, type MouseEvent } from "react";
import { createReactBlockSpec, createReactInlineContentSpec } from "@blocknote/react";
import { CALLOUT_KINDS, type CalloutKind } from "./constants";
import { PageLinkContext } from "./page-link-context";

/** Tiny document glyph shown when the target page has no emoji icon (or is unknown). */
function PageGlyph() {
  return (
    <svg
      className="hostidian-page-link__glyph"
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 1.75h5.2L12.25 4.8v9.45H4z" />
      <path d="M9 1.75V5h3.25" />
    </svg>
  );
}

/**
 * Inline reference to another page. Atomic (no editable content). The visible label is the page's *current* title from
 * `PageLinkContext`; without an answer (offline, deleted page, SSR, public pages) it falls back to the title stored in
 * the node, so rendering never throws and never needs a provider.
 */
export const pageLinkSpec = createReactInlineContentSpec(
  {
    type: "pageLink",
    propSchema: {
      pageId: { default: "" },
      title: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => {
      const { resolve, onNavigate } = useContext(PageLinkContext);
      const { pageId, title } = inlineContent.props;
      const info = resolve(pageId);
      const label = info?.title || title || "Untitled";
      const icon = info?.icon;
      const activate = () => {
        if (pageId) onNavigate(pageId);
      };
      return (
        <span
          className="hostidian-page-link"
          data-page-id={pageId}
          role="link"
          tabIndex={0}
          title={label}
          onClick={(event: MouseEvent) => {
            event.preventDefault();
            activate();
          }}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault();
              activate();
            }
          }}
        >
          {icon ? (
            <span className="hostidian-page-link__icon" aria-hidden="true">
              {icon}
            </span>
          ) : (
            <PageGlyph />
          )}
          <span className="hostidian-page-link__title">{label}</span>
        </span>
      );
    },
  },
);

const CALLOUT_ICONS: Record<CalloutKind, string> = {
  note: "\u{1F4DD}", // memo
  tip: "\u{1F4A1}", // light bulb
  warning: "⚠️", // warning sign
  danger: "\u{1F6D1}", // stop sign
};

const CALLOUT_LABELS: Record<CalloutKind, string> = {
  note: "Note",
  tip: "Tip",
  warning: "Warning",
  danger: "Danger",
};

function nextKind(kind: CalloutKind): CalloutKind {
  const index = CALLOUT_KINDS.indexOf(kind);
  return CALLOUT_KINDS[(index + 1) % CALLOUT_KINDS.length] ?? "note";
}

/**
 * Highlighted block with inline content (`> [!note] text` in Markdown). The icon button cycles the kind while the
 * editor is editable. Colours come from the `--callout-*` CSS variables in `styles.css`.
 */
export const createCalloutBlockSpec = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      kind: { default: "note", values: CALLOUT_KINDS },
    },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => {
      const kind = block.props.kind;
      return (
        <div className="hostidian-callout" data-kind={kind}>
          <button
            type="button"
            className="hostidian-callout__icon"
            contentEditable={false}
            title={`${CALLOUT_LABELS[kind]} (click to change)`}
            aria-label={`${CALLOUT_LABELS[kind]} callout`}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (editor.isEditable) {
                editor.updateBlock(block, { props: { kind: nextKind(kind) } });
              }
            }}
          >
            {CALLOUT_ICONS[kind]}
          </button>
          <div className="hostidian-callout__content" ref={contentRef} />
        </div>
      );
    },
  },
);
