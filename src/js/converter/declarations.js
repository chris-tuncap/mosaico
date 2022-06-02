"use strict";

// Parses CSS declarations and supports the property language (-ko-*) found between them.
// Create KO bindings but doesn't depend on KO.
// Needs a bindingProvider.

var addSlashes = require("./utils.js").addSlashes;
var converterUtils = require("./utils.js");
var cssParser = require("./cssparser.js");
var console = require("console");
var domutils = require("./domutils.js");

var _declarationValueLookup = function(declarations, propertyname, templateUrlConverter) {
  for (var i = declarations.length - 1; i >= 0; i--) {
    if (declarations[i].type == 'property' && declarations[i].name == propertyname) {
      return converterUtils.declarationValueUrlPrefixer(declarations[i].value, templateUrlConverter);
    }
  }
  return null;
};

var _propToCamelCase = function(propName) {
  return propName.replace(/-([a-z])/g, function(match, contents, offset, s) {
    return contents.toUpperCase();
  });
};

// element is only used for logging purposes
function _generateBindValue(declarations, bindingProvider, declarationname, declarationvalue, defaultValue, templateUrlConverter, element) {
  try {
    var bindValue = converterUtils.expressionBinding(declarationvalue, bindingProvider, defaultValue);
    // TODO evaluate the use of "-then" (and -else) postfixes to complete the -if instead of relaying
    // on the same basic sintax (or maybe it is better to support ternary operator COND ? THEN : ELSE).
    var declarationCondition = _declarationValueLookup(declarations, declarationname + '-if', templateUrlConverter);
    var not = false;
    if (declarationCondition === null) {
      declarationCondition = _declarationValueLookup(declarations, declarationname + '-ifnot', templateUrlConverter);
      not = true;
    } else {
      if (_declarationValueLookup(declarations, declarationname + '-ifnot', templateUrlConverter) !== null) {
        throw "Unexpected error: cannot use both -if and -ifnot property conditions";
      }
    }
    if (declarationCondition !== null) {
      try {
        var bindingCond = converterUtils.conditionBinding(declarationCondition, bindingProvider);

        // the match is a bit ugly, but we don't want to unwrap things if not needed (performance)
        if (bindingCond.match(/^[^' ]*[^' \)]$/)) bindingCond = 'ko.utils.unwrapObservable(' + bindingCond + ')';
        if (bindValue.match(/^[^' ]*[^' \)]$/)) bindValue = 'ko.utils.unwrapObservable(' + bindValue + ')';

        // bindingCond should already have surrounding brackets when needed (at least this is true until we find a bug and create a test case for it)
        if (not) bindingCond = '!' + bindingCond;

        bindValue = bindingCond + " ? " + bindValue + " : null";
      } catch (e) {
        console.error("Unable to deal with -ko style binding condition", declarationCondition, declarationname);
        throw e;
      }
    }
    return bindValue;
  } catch (e) {
    console.error("Model ensure path failed", e.stack, "name", declarationname, "value", declarationvalue, "default", defaultValue, "element", element);
    throw e;
  }
}

var _wrapStyle = function(style) {
  return "#{\n" + style + "}";
};

var _unwrapStyle = function(style) {
  return style.substring(3, style.length - 1);
};

var elaborateDeclarations = function(newStyle, declarations, templateUrlConverter, bindingProvider, element, removeDisplayNone) {
  var newBindings = {};
  for (var i = declarations.length - 1; i >= 0; i--)
    if (declarations[i].type == 'property') {
      if (removeDisplayNone === true && declarations[i].name == 'display' && declarations[i].value == 'none') {
        // when removeDisplayNone is true we always have a style, so this is not really needed
        if (newStyle !== null) {
          newStyle = cssParser.replaceStyle(newStyle, declarations[i].position.start, declarations[i].position.end, '');
        }
      } else {
        var decl = declarations[i].name.match(/^-ko-(bind-|attr-)?([A-Za-z0-9-]*?)(-if|-ifnot)?$/);
        if (decl !== null) {

          var isAttr = decl[1] == 'attr-';
          var isBind = decl[1] == 'bind-';
          var propName = decl[2];

          var isIf = decl[3] == '-if' || decl[3] == '-ifnot';
          var condDecl;
          var bindValue;
          var propDefaultValue;

          if (isIf) {
            condDecl = declarations[i].name.substr(0, declarations[i].name.length - decl[3].length);
            var conditionedDeclaration = _declarationValueLookup(declarations, condDecl, templateUrlConverter);
            if (conditionedDeclaration === null) throw "Unable to find declaration " + condDecl + " for " + declarations[i].name;
          } else {

            if ((isAttr || isBind) && (typeof element == 'undefined' && newStyle !== null)) throw "Attributes and bind declarations are only allowed in inline styles!";

            var needDefaultValue = true;
            var bindType;
            if (isAttr) {
              propDefaultValue = domutils.getAttribute(element, propName);
              needDefaultValue = false;
              bindType = 'virtualAttr';
            } else if (!isBind) {
              needDefaultValue = newStyle !== null;
              // in past we didn't read the default value when "needDefaultValue" was false: 
              // now we try to find it anyway, and simply don't enforce it.
              propDefaultValue = _declarationValueLookup(declarations, propName, templateUrlConverter);
              bindType = 'virtualStyle';
            } else {
              bindType = null;
              if (propName == 'text' || propName == 'stylesheet') {
                if (typeof element !== 'undefined') {
                  propDefaultValue = domutils.getInnerText(element);
                } else {
                  needDefaultValue = false;
                }
              } else if (propName == 'html') {
                if (typeof element !== 'undefined') {
                  propDefaultValue = domutils.getInnerHtml(element);
                } else {
                  needDefaultValue = false;
                }
              } else {
                needDefaultValue = false;
              }
            }

            if (needDefaultValue && propDefaultValue === null) {
              console.error("Cannot find default value for", declarations[i].name, declarations);
              throw "Cannot find default value for " + declarations[i].name + ": " + declarations[i].value + " in " + element + " (" + typeof newStyle + "/" + propName + ")";
            }
            var bindDefaultValue = propDefaultValue;

            var bindName = !isBind && !isAttr ? _propToCamelCase(propName) : (propName.indexOf('-') != -1 ? '\''+propName+'\'' : propName);

            bindValue = _generateBindValue(declarations, bindingProvider, declarations[i].name, declarations[i].value, propDefaultValue, templateUrlConverter);

            // Special handling for HREFs
            if (bindType == 'virtualAttr' && bindName == 'href') {
              bindType = null;
              bindName = 'wysiwygHref';
              // We have to remove it, otherwise we ends up with 2 rules writing it.
              if (typeof element != 'undefined' && element !== null) {
                domutils.removeAttribute(element, "href");
              }
            }

            if (bindType !== null) {
              if (typeof newBindings[bindType] == 'undefined') newBindings[bindType] = {};
              newBindings[bindType][bindName] = bindValue;
            } else newBindings[bindName] = bindValue;
          }

          // parsing @supports :preview
          // rimozione dello stile -ko- dall'attributo style.
          if (newStyle !== null) {

            try {
              // if "element" is defined then we are parsing an "inline" style and we want to remove it.
              if (typeof element != 'undefined' && element !== null) {
                newStyle = cssParser.replaceStyle(newStyle, declarations[i].position.start, declarations[i].position.end, '');
              } else {
                // otherwise we are parsing a full stylesheet.. let's rewrite the full "prop: value" without caring about the original syntax.
                var replacedWith = '';
                // if it is an "if" we simply have to remove it, otherwise we replace the input code with "prop: value" generating expression.
                if (!isIf) replacedWith = propName + ': <!-- ko text: ' + bindValue + ' -->' + propDefaultValue + '<!-- /ko -->';
                newStyle = cssParser.replaceStyle(newStyle, declarations[i].position.start, declarations[i].position.end, replacedWith);
              }
            } catch (e) {
              console.warn("Remove style failed", e, "name", declarations[i]);
              throw e;
            }

          }

        } else {
          // prefixing urls
          var replacedValue = converterUtils.declarationValueUrlPrefixer(declarations[i].value, templateUrlConverter);
          if (replacedValue != declarations[i].value) {
            if (newStyle !== null) {
              try {
                newStyle = cssParser.replaceStyle(newStyle, declarations[i].position.start, declarations[i].position.end, declarations[i].name + ": " + replacedValue);
              } catch (e) {
                console.log("Remove style failed replacing url", e, "name", declarations[i]);
                throw e;
              }
            }
          }

          // Style handling by concatenated "style attribute" (worse performance but more stable than direct style handling)
          var bindName2 = _propToCamelCase(declarations[i].name);
          var bind = 'virtualAttrStyle';
          var bindVal2 = typeof newBindings['virtualStyle'] !== 'undefined' ? newBindings['virtualStyle'][bindName2] : undefined;

          var dist = ' ';
          if (typeof newBindings[bind] == 'undefined') {
            newBindings[bind] = "''";
            dist = '';
          }

          if (typeof bindVal2 !== 'undefined') {
            // the match is a bit ugly, but we don't want to unwrap things if not needed (performance)
            if (bindVal2.match(/^[^' ]*[^' \)]$/)) bindVal2 = 'ko.utils.unwrapObservable(' + bindVal2 + ')';
            // make sure we use parentheses for ternary conditional operator
            else bindVal2 = '(' + bindVal2 + ')';
            newBindings[bind] = "'" + declarations[i].name + ": '+" + bindVal2 + "+';" + dist + "'+" + newBindings[bind];
            delete newBindings['virtualStyle'][bindName2];
          } else {
            newBindings[bind] = "'" + declarations[i].name + ": " + addSlashes(replacedValue) + ";" + dist + "'+" + newBindings[bind];
          }

        }
      }
    }

  if (typeof element != 'undefined' && element !== null) {
    for (var prop in newBindings['virtualStyle'])
      if (newBindings['virtualStyle'].hasOwnProperty(prop)) {
        console.log("Unexpected virtualStyle binding after conversion to virtualAttr.style", prop, newBindings['virtualStyle'][prop], newStyle);
        throw "Unexpected virtualStyle binding after conversion to virtualAttr.style for " + prop;
      }
    delete newBindings['virtualStyle'];

    var currentBindings = domutils.getAttribute(element, 'data-bind');
    var dataBind = (currentBindings !== null ? currentBindings + ", " : "") + _bindingSerializer(newBindings);
    if (dataBind == '') domutils.removeAttribute(element, 'data-bind');
    else domutils.setAttribute(element, 'data-bind', dataBind);
  }

  // TODO a function whose return type depends on the input parameters is very ugly.. please FIX ME.
  if (newStyle == null) {
    // clean virtualStyle if empty
    var hasVirtualStyle = false;
    for (var prop1 in newBindings['virtualStyle'])
      if (newBindings['virtualStyle'].hasOwnProperty(prop1)) {
        hasVirtualStyle = true;
        break;
      }
    if (!hasVirtualStyle) delete newBindings['virtualStyle'];
    else {
      // remove and add back virtualAttrStyle so it gets appended BEFORE virtualAttrStyle (_bindingSerializer reverse them...)
      if (typeof newBindings['virtualAttrStyle'] !== 'undefined') {
        var vs = newBindings['virtualAttrStyle'];
        delete newBindings['virtualAttrStyle'];
        newBindings['virtualAttrStyle'] = vs;
      }
    }
    // returns new serialized bindings
    return _bindingSerializer(newBindings);
  }

  return newStyle;
};

var _bindingSerializer = function(val) {
  var res = [];
  for (var prop in val)
    if (val.hasOwnProperty(prop)) {
      if (typeof val[prop] == 'object') res.push(prop + ": " + "{ " + _bindingSerializer(val[prop]) + " }");
      else res.push(prop + ": " + val[prop]);
    }
  return res.reverse().join(', ');
};

var elaborateDeclarationsAndReplaceStyles = function(style, declarations, templateUrlConverter, bindingProvider) {
  var res = elaborateDeclarations(style, declarations, templateUrlConverter, bindingProvider);
  if (res == null) return style;
  else return res;
};

var elaborateDeclarationsAndReturnStyleBindings = function(declarations, templateUrlConverter, bindingProvider) {
  return elaborateDeclarations(null, declarations, templateUrlConverter, bindingProvider);
};

// element and removeDisplayNone are optionals (declaration test suite call this without them)
var elaborateElementStyleDeclarations = function(style, templateUrlConverter, bindingProvider, element, removeDisplayNone) {
  var wStyle = _wrapStyle(style);
  var styleSheet = cssParser.parse(wStyle);
  var res = elaborateDeclarations(wStyle, styleSheet.stylesheet.rules[0].declarations, templateUrlConverter, bindingProvider, element, removeDisplayNone);
  if (res == null) return style;
  else return _unwrapStyle(res);
};


module.exports = {
  elaborateElementStyleDeclarations: elaborateElementStyleDeclarations,
  elaborateDeclarationsAndReplaceStyles: elaborateDeclarationsAndReplaceStyles,
  elaborateDeclarationsAndReturnStyleBindings: elaborateDeclarationsAndReturnStyleBindings,
  conditionBinding: converterUtils.conditionBinding,
  declarationValueUrlPrefixer: converterUtils.declarationValueUrlPrefixer
};