//brace to ace-bilds, your project need ace-builds // origin ->import ace from 'brace'; // eslint-disable-line
import * as ace from 'ace-builds';
import merge from 'lodash/merge';
import debounce from 'lodash/debounce';
import throttle from 'lodash/throttle';
import DiffMatchPatch from 'diff-match-patch';

import normalizeContent from './helpers/normalizeContent';
import getCurve from './visuals/getCurve';
import ensureElement from './dom/ensureElement';
import query from './dom/query';

//brace to ace-bilds, your project need ace-builds// origin -> const requireFunc = (ace.acequire || ace.require);
const requireFunc = (ace.require);

const { Range } = requireFunc('ace/range');

const C = {
  DIFF_EQUAL: 0,
  DIFF_DELETE: -1,
  DIFF_INSERT: 1,
  EDITOR_RIGHT: 'right',
  EDITOR_LEFT: 'left',
  RTL: 'rtl',
  LTR: 'ltr',
  SVG_NS: 'http://www.w3.org/2000/svg',
  DIFF_GRANULARITY_SPECIFIC: 'specific',
  DIFF_GRANULARITY_BROAD: 'broad',
};

// our constructor
function AceDiffy(options) {
  this.options = merge({
    mode: null,
    theme: null,
    element: null,
    diffGranularity: C.DIFF_GRANULARITY_BROAD,
    lockScrolling: false, // not implemented yet
    showDiffs: true,
    showConnectors: true,
    maxDiffs: 5000,
    left: {
      id: null,
      content: null,
      mode: null,
      theme: null,
      editable: true,
      copyLinkEnabled: true,
    },
    right: {
      id: null,
      content: null,
      mode: null,
      theme: null,
      editable: true,
      copyLinkEnabled: true,
    },
    classes: {
      gutterID: 'acediff__gutter',
      diff: 'acediff__diffLine',
      connector: 'acediff__connector',
      newCodeConnectorLink: 'acediff__newCodeConnector',
      newCodeConnectorLinkContent: '&#8594;',
      deletedCodeConnectorLink: 'acediff__deletedCodeConnector',
      deletedCodeConnectorLinkContent: '&#8592;',
      copyRightContainer: 'acediff__copy--right',
      copyLeftContainer: 'acediff__copy--left',
    },
    connectorYOffset: 0,
  }, options);

  if (this.options.element === null) {
    console.error('You need to specify an element for Ace-diff');
    return;
  }

  if (this.options.element instanceof HTMLElement) {
    this.el = this.options.element;
  } else {
    this.el = document.body.querySelector(this.options.element);
  }

  if (!this.el) {
    console.error(`Can't find the specified element ${this.options.element}`);
    return;
  }

  this.options.left.id = ensureElement(this.el, 'acediff__left');
  this.options.classes.gutterID = ensureElement(this.el, 'acediff__gutter');
  this.options.right.id = ensureElement(this.el, 'acediff__right');

  this.el.innerHTML = `<div class="acediff__wrap">${this.el.innerHTML}</div>`;

  // instantiate the editors in an internal data structure
  // that will store a little info about the diffs and
  // editor content
  this.editors = {
    left: {
      ace: ace.edit(this.options.left.id),
      markers: [],
      lineLengths: [],
    },
    right: {
      ace: ace.edit(this.options.right.id),
      markers: [],
      lineLengths: [],
    },
    editorHeight: null,
  };


  // set up the editors
  _setOptions(this);

  this.editors.left.ace.setValue(normalizeContent(this.options.left.content), -1);
  this.editors.right.ace.setValue(normalizeContent(this.options.right.content), -1);

  // store the visible height of the editors (assumed the same)
  this.editors.editorHeight = getEditorHeight(this);
}

// our public API
AceDiffy.prototype = {
  // allows on-the-fly changes to the AceDiffy instance settings
  setOptions(options) {
    merge(this.options, options);
    _setOptions(this);
    this.diff();
  },

  getNumDiffs() {
    return this.diffs.length;
  },

  // exposes the Ace editors in case the dev needs it
  getEditors() {
    return {
      left: this.editors.left.ace,
      right: this.editors.right.ace,
    };
  },

  async create() {
    const self = this;
    return new Promise((resolve, reject) => {
      setTimeout(function() {
        self.lineHeight = self.editors.left.ace.renderer.lineHeight;
        addEventHandlers(self);
        createCopyContainers(self);
        createGutter(self);
        self.diff();
        resolve()
      } , 1);
    });
   },

  // our main diffing function. I actually don't think this needs to exposed: it's called automatically,
  // but just to be safe, it's included
  diff() {
    const dmp = new DiffMatchPatch();
    const val1 = this.editors.left.ace.getSession().getValue();
    const val2 = this.editors.right.ace.getSession().getValue();
    const diff = dmp.diff_main(val2, val1);
    dmp.diff_cleanupSemantic(diff);

    this.editors.left.lineLengths = getLineLengths(this.editors.left);
    this.editors.right.lineLengths = getLineLengths(this.editors.right);

    // parse the raw diff into something a little more palatable
    const diffs = [];
    const offset = {
      left: 0,
      right: 0,
    };

    diff.forEach(function (chunk, index, array) {
      const chunkType = chunk[0];
      let text = chunk[1];

      // Fix for #28 https://github.com/ace-diff/ace-diff/issues/28
      if (array[index + 1] && text.endsWith('\n') && array[index + 1][1].startsWith('\n')) {
        text += '\n';
        diff[index][1] = text;
        diff[index + 1][1] = diff[index + 1][1].replace(/^\n/, '');
      }

      // oddly, occasionally the algorithm returns a diff with no changes made
      if (text.length === 0) {
        return;
      }
      if (chunkType === C.DIFF_EQUAL) {
        offset.left += text.length;
        offset.right += text.length;
      } else if (chunkType === C.DIFF_DELETE) {
        diffs.push(computeDiff(this, C.DIFF_DELETE, offset.left, offset.right, text));
        offset.right += text.length;
      } else if (chunkType === C.DIFF_INSERT) {
        diffs.push(computeDiff(this, C.DIFF_INSERT, offset.left, offset.right, text));
        offset.left += text.length;
      }
    }, this);

    // simplify our computed diffs; this groups together multiple diffs on subsequent lines
    this.diffs = simplifyDiffs(this, diffs);

    // if we're dealing with too many diffs, fail silently
    if (this.diffs.length > this.options.maxDiffs) {
      return;
    }

    clearDiffs(this);
    decorate(this);
  },

  destroy() {
    // destroy the two editors
    const leftValue = this.editors.left.ace.getValue();
    this.editors.left.ace.destroy();
    let oldDiv = this.editors.left.ace.container;
    let newDiv = oldDiv.cloneNode(false);
    newDiv.textContent = leftValue;
    oldDiv.parentNode.replaceChild(newDiv, oldDiv);

    const rightValue = this.editors.right.ace.getValue();
    this.editors.right.ace.destroy();
    oldDiv = this.editors.right.ace.container;
    newDiv = oldDiv.cloneNode(false);
    newDiv.textContent = rightValue;
    oldDiv.parentNode.replaceChild(newDiv, oldDiv);

    document.getElementById(this.options.classes.gutterID).innerHTML = '';
    removeEventHandlers();
  },
};


function getMode(acediff, editor) {
  let mode = acediff.options.mode;
  if (editor === C.EDITOR_LEFT && acediff.options.left.mode !== null) {
    mode = acediff.options.left.mode;
  }
  if (editor === C.EDITOR_RIGHT && acediff.options.right.mode !== null) {
    mode = acediff.options.right.mode;
  }
  return mode;
}


function getTheme(acediff, editor) {
  let theme = acediff.options.theme;
  if (editor === C.EDITOR_LEFT && acediff.options.left.theme !== null) {
    theme = acediff.options.left.theme;
  }
  if (editor === C.EDITOR_RIGHT && acediff.options.right.theme !== null) {
    theme = acediff.options.right.theme;
  }
  return theme;
}

let removeEventHandlers = () => {};

function addEventHandlers(acediff) {
  acediff.editors.left.ace.getSession().on('changeScrollTop', throttle((scroll) => { updateGap(acediff, 'left', scroll); }, 16));
  acediff.editors.right.ace.getSession().on('changeScrollTop', throttle((scroll) => { updateGap(acediff, 'right', scroll); }, 16));

  const diff = acediff.diff.bind(acediff);
  acediff.editors.left.ace.on('change', diff);
  acediff.editors.right.ace.on('change', diff);

  if (acediff.options.left.copyLinkEnabled) {
    query.on(`#${acediff.options.classes.gutterID}`, 'click', `.${acediff.options.classes.newCodeConnectorLink}`, (e) => {
      copy(acediff, e, C.LTR);
    });
  }
  if (acediff.options.right.copyLinkEnabled) {
    query.on(`#${acediff.options.classes.gutterID}`, 'click', `.${acediff.options.classes.deletedCodeConnectorLink}`, (e) => {
      copy(acediff, e, C.RTL);
    });
  }

  const onResize = debounce(() => {
    acediff.editors.availableHeight = document.getElementById(acediff.options.left.id).offsetHeight;

    // TODO this should re-init gutter
    acediff.diff();
  }, 250);

  window.addEventListener('resize', onResize);
  removeEventHandlers = () => {
    window.removeEventListener('resize', onResize);
  };
}


function copy(acediff, e, dir) {
  const diffIndex = parseInt(e.target.getAttribute('data-diff-index'), 10);
  const diff = acediff.diffs[diffIndex];
  let sourceEditor;
  let targetEditor;

  let startLine;
  let endLine;
  let targetStartLine;
  let targetEndLine;
  if (dir === C.LTR) {
    sourceEditor = acediff.editors.left;
    targetEditor = acediff.editors.right;
    startLine = diff.leftStartLine;
    endLine = diff.leftEndLine;
    targetStartLine = diff.rightStartLine;
    targetEndLine = diff.rightEndLine;
  } else {
    sourceEditor = acediff.editors.right;
    targetEditor = acediff.editors.left;
    startLine = diff.rightStartLine;
    endLine = diff.rightEndLine;
    targetStartLine = diff.leftStartLine;
    targetEndLine = diff.leftEndLine;
  }

  let contentToInsert = '';
  for (let i = startLine; i < endLine; i += 1) {
    contentToInsert += `${getLine(sourceEditor, i)}\n`;
  }

  // keep track of the scroll height
  const h = targetEditor.ace.getSession().getScrollTop();
  targetEditor.ace.getSession().replace(new Range(targetStartLine, 0, targetEndLine, 0), contentToInsert);
  targetEditor.ace.getSession().setScrollTop(parseInt(h, 10));

  acediff.diff();
}


function getLineLengths(editor) {
  const lines = editor.ace.getSession().doc.getAllLines();
  const lineLengths = [];
  lines.forEach((line) => {
    lineLengths.push(line.length + 1); // +1 for the newline char
  });
  return lineLengths;
}


// shows a diff in one of the two editors.
function showDiff(acediff, editor, startLine, endLine, className) {
  var editor = acediff.editors[editor];

  if (endLine < startLine) { // can this occur? Just in case.
    endLine = startLine;
  }

  const classNames = `${className} ${(endLine > startLine) ? 'lines' : 'targetOnly'}`;
  endLine--; // because endLine is always + 1

  // to get Ace to highlight the full row we just set the start and end chars to 0 and 1
  editor.markers.push(editor.ace.session.addMarker(new Range(startLine, 0, endLine, 1), classNames, 'fullLine'));
}


// called onscroll. Updates the gap to ensure the connectors are all lining up
function updateGap(acediff, editor, scroll) {
  clearDiffs(acediff);
  decorate(acediff);

  // reposition the copy containers containing all the arrows
  positionCopyContainers(acediff);
}


function clearDiffs(acediff) {
  acediff.editors.left.markers.forEach(function (marker) {
    this.editors.left.ace.getSession().removeMarker(marker);
  }, acediff);
  acediff.editors.right.markers.forEach(function (marker) {
    this.editors.right.ace.getSession().removeMarker(marker);
  }, acediff);
}


function addConnector(acediff, leftStartLine, leftEndLine, rightStartLine, rightEndLine) {
  const leftScrollTop = acediff.editors.left.ace.getSession().getScrollTop();
  const rightScrollTop = acediff.editors.right.ace.getSession().getScrollTop();

  // All connectors, regardless of ltr or rtl have the same point system, even if p1 === p3 or p2 === p4
  //  p1   p2
  //
  //  p3   p4

  acediff.connectorYOffset = 1;

  const p1_x = -1;
  const p1_y = (leftStartLine * acediff.lineHeight) - leftScrollTop + 0.5;
  const p2_x = acediff.gutterWidth + 1;
  const p2_y = rightStartLine * acediff.lineHeight - rightScrollTop + 0.5;
  const p3_x = -1;
  const p3_y = (leftEndLine * acediff.lineHeight) - leftScrollTop + acediff.connectorYOffset + 0.5;
  const p4_x = acediff.gutterWidth + 1;
  const p4_y = (rightEndLine * acediff.lineHeight) - rightScrollTop + acediff.connectorYOffset + 0.5;
  const curve1 = getCurve(p1_x, p1_y, p2_x, p2_y);
  const curve2 = getCurve(p4_x, p4_y, p3_x, p3_y);

  const verticalLine1 = `L${p2_x},${p2_y} ${p4_x},${p4_y}`;
  const verticalLine2 = `L${p3_x},${p3_y} ${p1_x},${p1_y}`;
  const d = `${curve1} ${verticalLine1} ${curve2} ${verticalLine2}`;

  const el = document.createElementNS(C.SVG_NS, 'path');
  el.setAttribute('d', d);
  el.setAttribute('class', acediff.options.classes.connector);
  acediff.gutterSVG.appendChild(el);
}


function addCopyArrows(acediff, info, diffIndex) {
  if (info.leftEndLine > info.leftStartLine && acediff.options.left.copyLinkEnabled) {
    var arrow = createArrow({
      className: acediff.options.classes.newCodeConnectorLink,
      topOffset: info.leftStartLine * acediff.lineHeight,
      tooltip: 'Copy to right',
      diffIndex,
      arrowContent: acediff.options.classes.newCodeConnectorLinkContent,
    });
    acediff.copyRightContainer.appendChild(arrow);
  }

  if (info.rightEndLine > info.rightStartLine && acediff.options.right.copyLinkEnabled) {
    var arrow = createArrow({
      className: acediff.options.classes.deletedCodeConnectorLink,
      topOffset: info.rightStartLine * acediff.lineHeight,
      tooltip: 'Copy to left',
      diffIndex,
      arrowContent: acediff.options.classes.deletedCodeConnectorLinkContent,
    });
    acediff.copyLeftContainer.appendChild(arrow);
  }
}


function positionCopyContainers(acediff) {
  const leftTopOffset = acediff.editors.left.ace.getSession().getScrollTop();
  const rightTopOffset = acediff.editors.right.ace.getSession().getScrollTop();

  acediff.copyRightContainer.style.cssText = `top: ${-leftTopOffset}px`;
  acediff.copyLeftContainer.style.cssText = `top: ${-rightTopOffset}px`;
}


/**
 * This method takes the raw diffing info from the Google lib and returns a nice clean object of the following
 * form:
 * {
 *   leftStartLine:
 *   leftEndLine:
 *   rightStartLine:
 *   rightEndLine:
 * }
 *
 * Ultimately, that's all the info we need to highlight the appropriate lines in the left + right editor, add the
 * SVG connectors, and include the appropriate <<, >> arrows.
 *
 * Note: leftEndLine and rightEndLine are always the start of the NEXT line, so for a single line diff, there will
 * be 1 separating the startLine and endLine values. So if leftStartLine === leftEndLine or rightStartLine ===
 * rightEndLine, it means that new content from the other editor is being inserted and a single 1px line will be
 * drawn.
 */
function computeDiff(acediff, diffType, offsetLeft, offsetRight, diffText) {
  let lineInfo = {};

  // this was added in to hack around an oddity with the Google lib. Sometimes it would include a newline
  // as the first char for a diff, other times not - and it would change when you were typing on-the-fly. This
  // is used to level things out so the diffs don't appear to shift around
  let newContentStartsWithNewline = /^\n/.test(diffText);

  if (diffType === C.DIFF_INSERT) {
    // pretty confident this returns the right stuff for the left editor: start & end line & char
    var info = getSingleDiffInfo(acediff.editors.left, offsetLeft, diffText);

    // this is the ACTUAL undoctored current line in the other editor. It's always right. Doesn't mean it's
    // going to be used as the start line for the diff though.
    var currentLineOtherEditor = getLineForCharPosition(acediff.editors.right, offsetRight);
    var numCharsOnLineOtherEditor = getCharsOnLine(acediff.editors.right, currentLineOtherEditor);
    const numCharsOnLeftEditorStartLine = getCharsOnLine(acediff.editors.left, info.startLine);
    var numCharsOnLine = getCharsOnLine(acediff.editors.left, info.startLine);

    // this is necessary because if a new diff starts on the FIRST char of the left editor, the diff can comes
    // back from google as being on the last char of the previous line so we need to bump it up one
    let rightStartLine = currentLineOtherEditor;
    if (numCharsOnLine === 0 && newContentStartsWithNewline) {
      newContentStartsWithNewline = false;
    }
    if (info.startChar === 0 && isLastChar(acediff.editors.right, offsetRight, newContentStartsWithNewline)) {
      rightStartLine = currentLineOtherEditor + 1;
    }

    var sameLineInsert = info.startLine === info.endLine;

    // whether or not this diff is a plain INSERT into the other editor, or overwrites a line take a little work to
    // figure out. This feels like the hardest part of the entire script.
    var numRows = 0;
    if (

      // dense, but this accommodates two scenarios:
      // 1. where a completely fresh new line is being inserted in left editor, we want the line on right to stay a 1px line
      // 2. where a new character is inserted at the start of a newline on the left but the line contains other stuff,
      //    we DO want to make it a full line
      (info.startChar > 0 || (sameLineInsert && diffText.length < numCharsOnLeftEditorStartLine)) &&

      // if the right editor line was empty, it's ALWAYS a single line insert [not an OR above?]
      numCharsOnLineOtherEditor > 0 &&

      // if the text being inserted starts mid-line
      (info.startChar < numCharsOnLeftEditorStartLine)) {
      numRows++;
    }

    lineInfo = {
      leftStartLine: info.startLine,
      leftEndLine: info.endLine + 1,
      rightStartLine,
      rightEndLine: rightStartLine + numRows,
    };
  } else {
    var info = getSingleDiffInfo(acediff.editors.right, offsetRight, diffText);

    var currentLineOtherEditor = getLineForCharPosition(acediff.editors.left, offsetLeft);
    var numCharsOnLineOtherEditor = getCharsOnLine(acediff.editors.left, currentLineOtherEditor);
    const numCharsOnRightEditorStartLine = getCharsOnLine(acediff.editors.right, info.startLine);
    var numCharsOnLine = getCharsOnLine(acediff.editors.right, info.startLine);

    // this is necessary because if a new diff starts on the FIRST char of the left editor, the diff can comes
    // back from google as being on the last char of the previous line so we need to bump it up one
    let leftStartLine = currentLineOtherEditor;
    if (numCharsOnLine === 0 && newContentStartsWithNewline) {
      newContentStartsWithNewline = false;
    }
    if (info.startChar === 0 && isLastChar(acediff.editors.left, offsetLeft, newContentStartsWithNewline)) {
      leftStartLine = currentLineOtherEditor + 1;
    }

    var sameLineInsert = info.startLine === info.endLine;
    var numRows = 0;
    if (

      // dense, but this accommodates two scenarios:
      // 1. where a completely fresh new line is being inserted in left editor, we want the line on right to stay a 1px line
      // 2. where a new character is inserted at the start of a newline on the left but the line contains other stuff,
      //    we DO want to make it a full line
      (info.startChar > 0 || (sameLineInsert && diffText.length < numCharsOnRightEditorStartLine)) &&

      // if the right editor line was empty, it's ALWAYS a single line insert [not an OR above?]
      numCharsOnLineOtherEditor > 0 &&

      // if the text being inserted starts mid-line
      (info.startChar < numCharsOnRightEditorStartLine)) {
      numRows++;
    }

    lineInfo = {
      leftStartLine,
      leftEndLine: leftStartLine + numRows,
      rightStartLine: info.startLine,
      rightEndLine: info.endLine + 1,
    };
  }

  return lineInfo;
}


// helper to return the startline, endline, startChar and endChar for a diff in a particular editor. Pretty
// fussy function
function getSingleDiffInfo(editor, offset, diffString) {
  const info = {
    startLine: 0,
    startChar: 0,
    endLine: 0,
    endChar: 0,
  };
  const endCharNum = offset + diffString.length;
  let runningTotal = 0;
  let startLineSet = false,
    endLineSet = false;

  editor.lineLengths.forEach((lineLength, lineIndex) => {
    runningTotal += lineLength;

    if (!startLineSet && offset < runningTotal) {
      info.startLine = lineIndex;
      info.startChar = offset - runningTotal + lineLength;
      startLineSet = true;
    }

    if (!endLineSet && endCharNum <= runningTotal) {
      info.endLine = lineIndex;
      info.endChar = endCharNum - runningTotal + lineLength;
      endLineSet = true;
    }
  });

  // if the start char is the final char on the line, it's a newline & we ignore it
  if (info.startChar > 0 && getCharsOnLine(editor, info.startLine) === info.startChar) {
    info.startLine++;
    info.startChar = 0;
  }

  // if the end char is the first char on the line, we don't want to highlight that extra line
  if (info.endChar === 0) {
    info.endLine--;
  }

  const endsWithNewline = /\n$/.test(diffString);
  if (info.startChar > 0 && endsWithNewline) {
    info.endLine++;
  }

  return info;
}


// note that this and everything else in this script uses 0-indexed row numbers
function getCharsOnLine(editor, line) {
  return getLine(editor, line).length;
}


function getLine(editor, line) {
  return editor.ace.getSession().doc.getLine(line);
}


function getLineForCharPosition(editor, offsetChars) {
  let lines = editor.ace.getSession().doc.getAllLines(),
    foundLine = 0,
    runningTotal = 0;

  for (let i = 0; i < lines.length; i++) {
    runningTotal += lines[i].length + 1; // +1 needed for newline char
    if (offsetChars <= runningTotal) {
      foundLine = i;
      break;
    }
  }
  return foundLine;
}


function isLastChar(editor, char, startsWithNewline) {
  let lines = editor.ace.getSession().doc.getAllLines(),
    runningTotal = 0,
    isLastChar = false;

  for (let i = 0; i < lines.length; i++) {
    runningTotal += lines[i].length + 1; // +1 needed for newline char
    let comparison = runningTotal;
    if (startsWithNewline) {
      comparison--;
    }

    if (char === comparison) {
      isLastChar = true;
      break;
    }
  }
  return isLastChar;
}


function createArrow(info) {
  const el = document.createElement('div');
  const props = {
    class: info.className,
    style: `top:${info.topOffset}px`,
    title: info.tooltip,
    'data-diff-index': info.diffIndex,
  };
  for (const key in props) {
    el.setAttribute(key, props[key]);
  }
  el.innerHTML = info.arrowContent;
  return el;
}


function createGutter(acediff) {
  acediff.gutterHeight = document.getElementById(acediff.options.classes.gutterID).clientHeight;
  acediff.gutterWidth = document.getElementById(acediff.options.classes.gutterID).clientWidth;

  const leftHeight = getTotalHeight(acediff, C.EDITOR_LEFT);
  const rightHeight = getTotalHeight(acediff, C.EDITOR_RIGHT);
  const height = Math.max(leftHeight, rightHeight, acediff.gutterHeight);

  acediff.gutterSVG = document.createElementNS(C.SVG_NS, 'svg');
  acediff.gutterSVG.setAttribute('width', acediff.gutterWidth);
  acediff.gutterSVG.setAttribute('height', height);

  document.getElementById(acediff.options.classes.gutterID).appendChild(acediff.gutterSVG);
}

// acediff.editors.left.ace.getSession().getLength() * acediff.lineHeight
function getTotalHeight(acediff, editor) {
  const ed = (editor === C.EDITOR_LEFT) ? acediff.editors.left : acediff.editors.right;
  return ed.ace.getSession().getLength() * acediff.lineHeight;
}

// creates two contains for positioning the copy left + copy right arrows
function createCopyContainers(acediff) {
  acediff.copyRightContainer = document.createElement('div');
  acediff.copyRightContainer.setAttribute('class', acediff.options.classes.copyRightContainer);
  acediff.copyLeftContainer = document.createElement('div');
  acediff.copyLeftContainer.setAttribute('class', acediff.options.classes.copyLeftContainer);

  document.getElementById(acediff.options.classes.gutterID).appendChild(acediff.copyRightContainer);
  document.getElementById(acediff.options.classes.gutterID).appendChild(acediff.copyLeftContainer);
}


function clearGutter(acediff) {
  // gutter.innerHTML = '';

  const gutterEl = document.getElementById(acediff.options.classes.gutterID);

  if(typeof gutterEl !== 'undefined'
    && typeof acediff.gutterSVG !== 'undefined'
    && gutterEl.contains(acediff.gutterSVG)
   ) {
    gutterEl.removeChild(acediff.gutterSVG);
  }

  createGutter(acediff);
}


function clearArrows(acediff) {
  acediff.copyLeftContainer.innerHTML = '';
  acediff.copyRightContainer.innerHTML = '';
}


/*
  * This combines multiple rows where, say, line 1 => line 1, line 2 => line 2, line 3-4 => line 3. That could be
  * reduced to a single connector line 1=4 => line 1-3
  */
function simplifyDiffs(acediff, diffs) {
  const groupedDiffs = [];

  function compare(val) {
    return (acediff.options.diffGranularity === C.DIFF_GRANULARITY_SPECIFIC) ? val < 1 : val <= 1;
  }

  diffs.forEach((diff, index) => {
    if (index === 0) {
      groupedDiffs.push(diff);
      return;
    }

    // loop through all grouped diffs. If this new diff lies between an existing one, we'll just add to it, rather
    // than create a new one
    let isGrouped = false;
    for (let i = 0; i < groupedDiffs.length; i++) {
      if (compare(Math.abs(diff.leftStartLine - groupedDiffs[i].leftEndLine)) &&
          compare(Math.abs(diff.rightStartLine - groupedDiffs[i].rightEndLine))) {
        // update the existing grouped diff to expand its horizons to include this new diff start + end lines
        groupedDiffs[i].leftStartLine = Math.min(diff.leftStartLine, groupedDiffs[i].leftStartLine);
        groupedDiffs[i].rightStartLine = Math.min(diff.rightStartLine, groupedDiffs[i].rightStartLine);
        groupedDiffs[i].leftEndLine = Math.max(diff.leftEndLine, groupedDiffs[i].leftEndLine);
        groupedDiffs[i].rightEndLine = Math.max(diff.rightEndLine, groupedDiffs[i].rightEndLine);
        isGrouped = true;
        break;
      }
    }

    if (!isGrouped) {
      groupedDiffs.push(diff);
    }
  });

  // clear out any single line diffs (i.e. single line on both editors)
  const fullDiffs = [];
  groupedDiffs.forEach((diff) => {
    if (diff.leftStartLine === diff.leftEndLine && diff.rightStartLine === diff.rightEndLine) {
      return;
    }
    fullDiffs.push(diff);
  });

  return fullDiffs;
}


function decorate(acediff) {
  clearGutter(acediff);
  clearArrows(acediff);

  acediff.diffs.forEach(function (info, diffIndex) {
    if (this.options.showDiffs) {
      showDiff(this, C.EDITOR_LEFT, info.leftStartLine, info.leftEndLine, this.options.classes.diff);
      showDiff(this, C.EDITOR_RIGHT, info.rightStartLine, info.rightEndLine, this.options.classes.diff);

      if (this.options.showConnectors) {
        addConnector(this, info.leftStartLine, info.leftEndLine, info.rightStartLine, info.rightEndLine);
      }
      addCopyArrows(this, info, diffIndex);
    }
  }, acediff);
}

function getScrollingInfo(acediff, dir) {
  return (dir == C.EDITOR_LEFT) ? acediff.editors.left.ace.getSession().getScrollTop() : acediff.editors.right.ace.getSession().getScrollTop();
}

function getEditorHeight(acediff) {
  // editorHeight: document.getElementById(acediff.options.left.id).clientHeight
  return document.getElementById(acediff.options.left.id).offsetHeight;
}

function _setOptions(acediff) {
  acediff.editors.left.ace.getSession().setMode(getMode(acediff, C.EDITOR_LEFT));
  acediff.editors.right.ace.getSession().setMode(getMode(acediff, C.EDITOR_RIGHT));
  acediff.editors.left.ace.setReadOnly(!acediff.options.left.editable);
  acediff.editors.right.ace.setReadOnly(!acediff.options.right.editable);
  acediff.editors.left.ace.setTheme(getTheme(acediff, C.EDITOR_LEFT));
  acediff.editors.right.ace.setTheme(getTheme(acediff, C.EDITOR_RIGHT));
}

export default AceDiffy;
