import { AnnotationType, Annotation, RangeSet, Range } from "@codemirror/state";
import {
	EditorView,
	ViewUpdate,
	ViewPlugin,
	Decoration,
	WidgetType
} from "@codemirror/view";

import type { PluginValue, DecorationSet } from "@codemirror/view";

export const remoteCursorsTheme = EditorView.baseTheme({
	".Selection": {},
	".LineSelection": {
		padding: 0,
		margin: "0px 2px 0px 4px"
	},
	".SelectionCaret": {
		position: "relative",
		borderLeft: "1px solid black",
		borderRight: "1px solid black",
		marginLeft: "-1px",
		marginRight: "-1px",
		boxSizing: "border-box",
		display: "inline"
	},
	".SelectionCaretDot": {
		borderRadius: "50%",
		position: "absolute",
		width: ".4em",
		height: ".4em",
		top: "-.2em",
		left: "-.2em",
		backgroundColor: "inherit",
		transition: "transform .3s ease-in-out",
		boxSizing: "border-box"
	},
	".SelectionCaret:hover > .SelectionCaretDot": {
		transformOrigin: "bottom center",
		transform: "scale(0)"
	},
	".SelectionInfo": {
		position: "absolute",
		top: "-1.05em",
		left: "-1px",
		fontSize: ".75em",
		fontFamily: "serif",
		fontStyle: "normal",
		fontWeight: "normal",
		lineHeight: "normal",
		userSelect: "none",
		color: "white",
		paddingLeft: "2px",
		paddingRight: "2px",
		zIndex: 101,
		transition: "opacity .3s ease-in-out",
		backgroundColor: "inherit",
		// these should be separate
		opacity: 0,
		transitionDelay: "0s",
		whiteSpace: "nowrap"
	},
	".SelectionCaret:hover > .SelectionInfo": {
		opacity: 1,
		transitionDelay: "0s"
	}
});
