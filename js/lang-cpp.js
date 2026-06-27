hljs.registerLanguage('cpp', function(hljs) {
  var KEYWORDS = {
    $pattern: /[a-zA-Z_]\w*/,
    keyword:
      'alignas alignof asm auto bool break case catch char char16_t char32_t ' +
      'class const constexpr decltype default delete do double else enum explicit ' +
      'export extern false float for friend goto if inline int long mutable ' +
      'namespace new noexcept nullptr operator override private protected public ' +
      'register return short signed sizeof static static_assert struct switch ' +
      'template this throw true try typedef typeid typename union unsigned ' +
      'using virtual void volatile while',
    type:
      'int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t ' +
      'size_t ptrdiff_t nullptr_t wchar_t ' +
      'string vector map array atomic mutex ' +
      'shared_ptr unique_ptr weak_ptr function bind tuple pair ' +
      'optional variant any initializer_list complex',
    built_in:
      'cout cin cerr clog endl make_shared make_unique make_pair make_tuple ' +
      'make_optional make_variant forward move move_if_noexcept ' +
      'printf scanf fopen fclose fprintf fscanf malloc calloc realloc free ' +
      'std string int long short char float double bool void'
  };

  var PREPROCESSOR = {
    className: 'meta',
    begin: /#\s*[a-z]+\b/,
    end: /$/,
    contains: [
      {
        className: 'meta-string',
        begin: /"/,
        end: /"/,
        contains: [{ begin: /\\./ }]
      }
    ]
  };

  var COMMENT_LINE = {
    className: 'comment',
    begin: /\/\//,
    end: /$/,
    contains: [{ begin: /\\\n/ }]
  };

  var COMMENT_BLOCK = {
    className: 'comment',
    begin: /\/\*/,
    end: /\*\//
  };

  var RAW_STRING = {
    className: 'string',
    begin: /R"\s*\(/,
    end: /\)\s*"/,
    relevance: 10
  };

  var STRING = {
    className: 'string',
    begin: /"/,
    end: /"/,
    contains: [{ begin: /\\./ }],
    relevance: 0
  };

  var CHAR_LITERAL = {
    className: 'string',
    begin: /'(?:\\.|[^'\\])'/,
    relevance: 0
  };

  var NUMBER = {
    className: 'number',
    variants: [
      { begin: /\b(0b[01']+)\b/ },
      { begin: /\b(0x[\da-fA-F']+)\b/ },
      { begin: /\b(\d[\d']*(?:\.[\d']*)?(?:e[+-]?\d[\d']*)?)[fFlL]?\b/ },
      { begin: /\b(\d[\d']*\.\d[\d']*)[fFlL]?\b/ }
    ],
    relevance: 0
  };

  var OPERATORS = {
    className: 'operator',
    begin: /[{}[\]()]|->|::|\.\*|->\*|<<|>>|<=>|\.\.\.|[+\-*\/%&|^~!<>=]=?|&&|\|\||\+\+|--|\?\:/
  };

  var FUNCTION = {
    className: 'function',
    begin: /\b([a-zA-Z_]\w*)\s*(?=\()/,
    end: /(?={|;)/,
    excludeEnd: true,
    keywords: KEYWORDS,
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.C_BLOCK_COMMENT_MODE,
      RAW_STRING,
      STRING,
      CHAR_LITERAL,
      NUMBER
    ],
    illegal: /[^\[\]a-zA-Z_0-9\s,.*&<>=\-+~!|&^%?:]/,
    relevance: 0
  };

  var LAMBDA = {
    className: 'operator',
    begin: /\[(?:=|\&|\w)*(?:\s*,\s*(?:=|\&|\w))*\]\s*\(/,
    end: /\)\s*(?:->\s*\w+(?:\s*::\s*\w+)*(?:\s*<[^>]*>)?)?\s*(?:const|mutable|noexcept)?\s*\{/,
    contains: [
      STRING,
      CHAR_LITERAL,
      NUMBER
    ]
  };

  return {
    name: 'C++',
    aliases: ['cc', 'c++', 'cxx', 'h', 'hpp', 'cplusplus'],
    keywords: KEYWORDS,
    contains: [
      PREPROCESSOR,
      COMMENT_LINE,
      COMMENT_BLOCK,
      RAW_STRING,
      STRING,
      CHAR_LITERAL,
      NUMBER,
      FUNCTION,
      OPERATORS
    ]
  };
});
