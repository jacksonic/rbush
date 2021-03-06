/*
 (c) 2015, Vladimir Agafonkin
 RBush, a JavaScript library for high-performance 2D spatial indexing of points and rectangles.
 https://github.com/mourner/rbush
*/

(function () {
'use strict';

function rbush(maxEntries, format, dimension) {

    // jshint newcap: false, validthis: true
    if (!(this instanceof rbush)) return new rbush(maxEntries, format, dimension);

    // dimensions specifies the number of axes (2 ==> x,y; 3 ==> x,y,z; ...)
    dimension = parseInt(dimension);
    if (!dimension || dimension < 2) dimension = 2;
    this._dimension = dimension;

    // max entries in a node is 9 by default; min node fill is 40% for best performance
    this._maxEntries = Math.max(4, maxEntries || 9);
    this._minEntries = Math.max(2, Math.ceil(this._maxEntries * 0.4));

    if (format) {
        this._initFormat(format);
    }

    this.clear();
}

rbush.prototype = {

    all: function () {
        return this._all(this.data, []);
    },

    search: function (bbox) {

        var node = this.data,
            result = [],
            toBBox = this.toBBox;

        if (!intersects(this._dimension, bbox, node.bbox)) return result;

        var nodesToSearch = [],
            i, len, child, childBBox;

        while (node) {
            for (i = 0, len = node.children.length; i < len; i++) {

                child = node.children[i];
                childBBox = node.leaf ? toBBox(child) : child.bbox;

                if (intersects(this._dimension, bbox, childBBox)) {
                    if (node.leaf) result.push(child);
                    else if (contains(this._dimension, bbox, childBBox)) this._all(child, result);
                    else nodesToSearch.push(child);
                }
            }
            node = nodesToSearch.pop();
        }

        return result;
    },

    collides: function (bbox) {

        var node = this.data,
            toBBox = this.toBBox;

        if (!intersects(this._dimension, bbox, node.bbox)) return false;

        var nodesToSearch = [],
            i, len, child, childBBox;

        while (node) {
            for (i = 0, len = node.children.length; i < len; i++) {

                child = node.children[i];
                childBBox = node.leaf ? toBBox(child) : child.bbox;

                if (intersects(this._dimension, bbox, childBBox)) {
                    if (node.leaf || contains(this._dimension, bbox, childBBox)) return true;
                    nodesToSearch.push(child);
                }
            }
            node = nodesToSearch.pop();
        }

        return false;
    },

    load: function (data) {
        if (!(data && data.length)) return this;

        if (data.length < this._minEntries) {
            for (var i = 0, len = data.length; i < len; i++) {
                this.insert(data[i]);
            }
            return this;
        }

        // recursively build the tree with the given data from stratch using OMT algorithm
        var node = this._build(data.slice(), 0, data.length - 1, 0);

        if (!this.data.children.length) {
            // save as is if tree is empty
            this.data = node;

        } else if (this.data.height === node.height) {
            // split root if trees have the same height
            this._splitRoot(this.data, node);

        } else {
            if (this.data.height < node.height) {
                // swap trees if inserted one is bigger
                var tmpNode = this.data;
                this.data = node;
                node = tmpNode;
            }

            // insert the small tree into the large tree at appropriate level
            this._insert(node, this.data.height - node.height - 1, true);
        }

        return this;
    },

    insert: function (item) {
        if (item) this._insert(item, this.data.height - 1);
        return this;
    },

    clear: function () {
        this.data = {
            children: [],
            height: 1,
            bbox: empty(this._dimension),
            leaf: true
        };
        return this;
    },

    remove: function (item) {
        if (!item) return this;

        var node = this.data,
            bbox = this.toBBox(item),
            path = [],
            indexes = [],
            i, parent, index, goingUp;

        // depth-first iterative tree traversal
        while (node || path.length) {

            if (!node) { // go up
                node = path.pop();
                parent = path[path.length - 1];
                i = indexes.pop();
                goingUp = true;
            }

            if (node.leaf) { // check current node
                index = node.children.indexOf(item);

                if (index !== -1) {
                    // item found, remove the item and condense tree upwards
                    node.children.splice(index, 1);
                    path.push(node);
                    this._condense(path);
                    return this;
                }
            }

            if (!goingUp && !node.leaf && contains(this._dimension, node.bbox, bbox)) { // go down
                path.push(node);
                indexes.push(i);
                i = 0;
                parent = node;
                node = node.children[0];

            } else if (parent) { // go right
                i++;
                node = parent.children[i];
                goingUp = false;

            } else node = null; // nothing found
        }

        return this;
    },

    toBBox: function (item) { return item; },

    compareMin: function (axis, a, b) { return a[axis] - b[axis]; },

    toJSON: function () { return this.data; },

    fromJSON: function (data) {
        this.data = data;
        return this;
    },

    _all: function (node, result) {
        var nodesToSearch = [];
        while (node) {
            if (node.leaf) result.push.apply(result, node.children);
            else nodesToSearch.push.apply(nodesToSearch, node.children);

            node = nodesToSearch.pop();
        }
        return result;
    },

    _build: function (items, left, right, height) {

        var N = right - left + 1,
            M = this._maxEntries,
            node;

        if (N <= M) {
            // reached leaf level; return leaf
            node = {
                children: items.slice(left, right + 1),
                height: 1,
                bbox: null,
                leaf: true
            };
            calcBBox(this._dimension, node, this.toBBox);
            return node;
        }

        if (!height) {
            // target height of the bulk-loaded tree
            height = Math.ceil(Math.log(N) / Math.log(M));

            // target number of root entries to maximize storage utilization
            M = Math.ceil(N / Math.pow(M, height - 1));
        }

        node = {
            children: [],
            height: height,
            bbox: null,
            leaf: false
        };

        // split the items into M mostly square/cube tiles

        var N2 = Math.ceil(N / M),
            N1 = N2 * Math.ceil(Math.sqrt(M)),
            self = this;

        var buildAxis = function buildAxis(axis, left, right, N1, N2) {
          multiSelect(items, left, right, N1, self.compareMin, axis);

          for (var i = left; i <= right; i += N1) {
            var newRight = Math.min(i + N1 - 1, right);
            if (axis + 1 < self._dimension) {
              buildAxis(axis + 1, i, newRight, N2, N1); // swap N1, N2 each recursion?
            } else {
              // pack each entry recursively
              node.children.push(self._build(items, i, newRight, height - 1));
            }
          }
        };
        buildAxis(0, left, right, N1, N2);

        calcBBox(this._dimension, node, this.toBBox);

        return node;
    },

    _chooseSubtree: function (bbox, node, level, path) {

        var i, len, child, targetNode, area, enlargement, minArea, minEnlargement;

        while (true) {
            path.push(node);

            if (node.leaf || path.length - 1 === level) break;

            minArea = minEnlargement = Infinity;

            for (i = 0, len = node.children.length; i < len; i++) {
                child = node.children[i];
                area = bboxArea(this._dimension, child.bbox);
                enlargement = enlargedArea(this._dimension, bbox, child.bbox) - area;

                // choose entry with the least area enlargement
                if (enlargement < minEnlargement) {
                    minEnlargement = enlargement;
                    minArea = area < minArea ? area : minArea;
                    targetNode = child;

                } else if (enlargement === minEnlargement) {
                    // otherwise choose one with the smallest area
                    if (area < minArea) {
                        minArea = area;
                        targetNode = child;
                    }
                }
            }

            node = targetNode;
        }

        return node;
    },

    _insert: function (item, level, isNode) {

        var toBBox = this.toBBox,
            bbox = isNode ? item.bbox : toBBox(item),
            insertPath = [];

        // find the best node for accommodating the item, saving all nodes along the path too
        var node = this._chooseSubtree(bbox, this.data, level, insertPath);

        // put the item into the node
        node.children.push(item);
        extend(this._dimension, node.bbox, bbox);

        // split on node overflow; propagate upwards if necessary
        while (level >= 0) {
            if (insertPath[level].children.length > this._maxEntries) {
                this._split(insertPath, level);
                level--;
            } else break;
        }

        // adjust bboxes along the insertion path
        this._adjustParentBBoxes(bbox, insertPath, level);
    },

    // split overflowed node into two
    _split: function (insertPath, level) {

        var node = insertPath[level],
            M = node.children.length,
            m = this._minEntries;

        this._chooseSplitAxis(node, m, M);

        var splitIndex = this._chooseSplitIndex(node, m, M);

        var newNode = {
            children: node.children.splice(splitIndex, node.children.length - splitIndex),
            height: node.height,
            bbox: null,
            leaf: false
        };

        if (node.leaf) newNode.leaf = true;

        calcBBox(this._dimension, node, this.toBBox);
        calcBBox(this._dimension, newNode, this.toBBox);

        if (level) insertPath[level - 1].children.push(newNode);
        else this._splitRoot(node, newNode);
    },

    _splitRoot: function (node, newNode) {
        // split root node
        this.data = {
            children: [node, newNode],
            height: node.height + 1,
            bbox: null,
            leaf: false
        };
        calcBBox(this._dimension, this.data, this.toBBox);
    },

    _chooseSplitIndex: function (node, m, M) {

        var i, bbox1, bbox2, overlap, area, minOverlap, minArea, index;

        minOverlap = minArea = Infinity;

        for (i = m; i <= M - m; i++) {
            bbox1 = distBBox(this._dimension, node, 0, i, this.toBBox);
            bbox2 = distBBox(this._dimension, node, i, M, this.toBBox);

            overlap = intersectionArea(this._dimension, bbox1, bbox2);
            area = bboxArea(this._dimension, bbox1) + bboxArea(this._dimension, bbox2);

            // choose distribution with minimum overlap
            if (overlap < minOverlap) {
                minOverlap = overlap;
                index = i;

                minArea = area < minArea ? area : minArea;

            } else if (overlap === minOverlap) {
                // otherwise choose distribution with minimum area
                if (area < minArea) {
                    minArea = area;
                    index = i;
                }
            }
        }

        return index;
    },

    // sorts node children by the best axis for split
    _chooseSplitAxis: function (node, m, M) {
        var a;
        var bestAxis = 0;
        var bestMargin = Math.Infinity;
        for (a = 0; a < this._dimension; ++a) {
          var compareMin = node.leaf ? this.compareMin : compareNodeMin;
          var margin = this._allDistMargin(node, m, M, compareMin, a);
          if (margin <= bestMargin) {
            bestMargin = margin;
            bestAxis = a;
          }
        }
        // if total distributions margin value is minimal for x, sort by minX,
        // otherwise it's already sorted by minY
        if (a < this._dimension) {
          node.children.sort(compareMin.bind(node.children, bestAxis));
        }
    },

    // total margin of all possible split distributions where each node is at least m full
    _allDistMargin: function (node, m, M, compare, axis) {

        node.children.sort(compare.bind(node.children, axis));

        var toBBox = this.toBBox,
            leftBBox = distBBox(this._dimension, node, 0, m, toBBox),
            rightBBox = distBBox(this._dimension, node, M - m, M, toBBox),
            margin = bboxMargin(this._dimension, leftBBox) + bboxMargin(this._dimension, rightBBox),
            i, child;

        for (i = m; i < M - m; i++) {
            child = node.children[i];
            extend(this._dimension, leftBBox, node.leaf ? toBBox(child) : child.bbox);
            margin += bboxMargin(this._dimension, leftBBox);
        }

        for (i = M - m - 1; i >= m; i--) {
            child = node.children[i];
            extend(this._dimension, rightBBox, node.leaf ? toBBox(child) : child.bbox);
            margin += bboxMargin(this._dimension, rightBBox);
        }

        return margin;
    },

    _adjustParentBBoxes: function (bbox, path, level) {
        // adjust bboxes along the given tree path
        for (var i = level; i >= 0; i--) {
            extend(this._dimension, path[i].bbox, bbox);
        }
    },

    _condense: function (path) {
        // go through the path, removing empty nodes and updating bboxes
        for (var i = path.length - 1, siblings; i >= 0; i--) {
            if (path[i].children.length === 0) {
                if (i > 0) {
                    siblings = path[i - 1].children;
                    siblings.splice(siblings.indexOf(path[i]), 1);

                } else this.clear();

            } else calcBBox(this._dimension, path[i], this.toBBox);
        }
    },

    _initFormat: function (format) {
        // data format (minX, minY, maxX, maxY accessors)

        // uses eval-type function compilation instead of just accepting a toBBox function
        // because the algorithms are very sensitive to sorting functions performance,
        // so they should be dead simple and without inner calls

        // jshint evil: true

        var compareArr = ['return a', ' - b', ';'];

        this.compareMin = new Function('axis', 'a', 'b', compareArr.join(format[0]));

        this.toBBox = new Function('a', 'return [a' + format.join(', a') + '];');
    }
};


// calculate node's bbox from bboxes of its children
function calcBBox(dim, node, toBBox) {
    node.bbox = distBBox(dim, node, 0, node.children.length, toBBox);
}

// min bounding rectangle of node children from k to p-1
function distBBox(dim, node, k, p, toBBox) {
    var bbox = empty(dim);

    for (var i = k, child; i < p; i++) {
        child = node.children[i];
        extend(dim, bbox, node.leaf ? toBBox(child) : child.bbox);
    }

    return bbox;
}
// global functions don't know dimension
var __empty__ = [];
function empty(d) {
  if (!__empty__[d]) {
    __empty__[d] = [];
    for (var i = 0; i < d; ++i) {
      __empty__[d][i] = Infinity;
      __empty__[d][d + i] = -Infinity;
    }
  } else {
    return __empty__[d].slice();
  }
}

function extend(dim, a, b) {
    var j, i;
    for (i = 0; i < dim; ++i) {
      j = dim + i;
      a[i] = Math.min(a[i], b[i]);
      a[j] = Math.max(a[j], b[j]);
    }
    return a;
}

function compareNodeMin(axis, a, b) { return a.bbox[axis] - b.bbox[axis]; }

function bboxArea(dim, a)   {
  var j, i,
    area = 1;
  for (i = 0; i < dim; ++i) {
    j = dim + i;
    area *= a[j] - a[i];
  }
  return area;
}
function bboxMargin(dim, a) {
  var j, i,
    margin = 0;
  for (i = 0; i < dim; ++i) {
    j = dim + i;
    margin += a[j] - a[i];
  }
  return margin;
}

function enlargedArea(dim, a, b) {
  var j, i,
    area = 1;
  for (i = 0; i < dim; ++i) {
    j = dim + i;
    area *= Math.max(b[j], a[j]) - Math.min(b[i], a[i]);
  }
  return area;
}

function intersectionArea(dim, a, b) {
  var j, i,
    area = 1;
  for (i = 0; i < dim; ++i) {
    j = dim + i;
    area *= Math.max(0, Math.max(b[i], a[i]) - Math.min(b[j], a[j]));
    if (area === 0) break;
  }
  return area;
}

function contains(dim, a, b) {
  var j, i;
  for (i = 0; i < dim; ++i) {
    j = dim + i;
    if (a[i] > b[i] || b[j] > a[j]) return false;
  }
  return true;
}

function intersects(dim, a, b) {
  var j, i;
  for (i = 0; i < dim; ++i) {
    j = dim + i;
    if (a[j] < b[i] || b[j] < a[i]) return false;
  }
  return true;
}

// sort an array so that items come in groups of n unsorted items, with groups sorted between each other;
// combines selection algorithm with binary divide & conquer approach

function multiSelect(arr, left, right, n, compare, axis) {
    var stack = [left, right],
        mid;

    while (stack.length) {
        right = stack.pop();
        left = stack.pop();

        if (right - left <= n) continue;

        mid = left + Math.ceil((right - left) / n / 2) * n;
        select(arr, left, right, mid, compare, axis);

        stack.push(left, mid, mid, right);
    }
}

// Floyd-Rivest selection algorithm:
// sort an array between left and right (inclusive) so that the smallest k elements come first (unordered)
function select(arr, left, right, k, compare, axis) {
    var n, i, z, s, sd, newLeft, newRight, t, j;

    while (right > left) {
        if (right - left > 600) {
            n = right - left + 1;
            i = k - left + 1;
            z = Math.log(n);
            s = 0.5 * Math.exp(2 * z / 3);
            sd = 0.5 * Math.sqrt(z * s * (n - s) / n) * (i - n / 2 < 0 ? -1 : 1);
            newLeft = Math.max(left, Math.floor(k - i * s / n + sd));
            newRight = Math.min(right, Math.floor(k + (n - i) * s / n + sd));
            select(arr, newLeft, newRight, k, compare, axis);
        }

        t = arr[k];
        i = left;
        j = right;

        swap(arr, left, k);
        if (compare(axis, arr[right], t) > 0) swap(arr, left, right);

        while (i < j) {
            swap(arr, i, j);
            i++;
            j--;
            while (compare(axis, arr[i], t) < 0) i++;
            while (compare(axis, arr[j], t) > 0) j--;
        }

        if (compare(axis, arr[left], t) === 0) swap(arr, left, j);
        else {
            j++;
            swap(arr, j, right);
        }

        if (j <= k) left = j + 1;
        if (k <= j) right = j - 1;
    }
}

function swap(arr, i, j) {
    var tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
}


// export as AMD/CommonJS module or global variable
if (typeof define === 'function' && define.amd) define('rbush', function () { return rbush; });
else if (typeof module !== 'undefined') module.exports = rbush;
else if (typeof self !== 'undefined') self.rbush = rbush;
else window.rbush = rbush;

})();
