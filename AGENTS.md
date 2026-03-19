# AGENTS.md - Guidelines for Agentic Coding in LlmTranslator

This file provides instructions for AI coding agents (e.g., opencode) working on the LlmTranslator repository. It includes code style guidelines, conventions, and requirements for maintaining consistency. The project is a stand-alone HTML/TypeScript application for translating natural language using OpenRouter.

**CRITICAL**: Agents must write NEW code that strictly follows these guidelines, even if the existing codebase does not follow them.

## 1. General Principles

- **Readability First**: Code should be self-explanatory. Use descriptive names and structures.
- **Modularity**: Keep functions small (<100 lines). One responsibility per function.
- **Security**: Never expose secrets. Validate user inputs.
- **Performance**: Optimize for client-side (e.g., avoid large loops; use efficient data structures like Maps/Sets).
- **Browser Compatibility**: Support modern browsers (Chrome, Firefox, Safari). Avoid polyfills unless necessary.
- **Code Functionality**: Agents must write fully functional, production-ready code unless the user explicitly requests stubs, placeholders, or incomplete implementations. Avoid TODO comments or non-working code segments—ensure all logic is complete and runnable.

## 2. Testing

- **Agents DO NOT run tests**: User performs all manual testing
- `npm run dev`: Start development server at http://localhost:8002/
- No automated tests - manual browser testing only

## 3. Build/Lint Commands

- `npm run dev` - Start development server at http://localhost:8002/
- `npm run type-check` - Run TypeScript strict type check (tsc --noEmit)
- `npm run build` - Production build (tsc && vite build)
- `npm run preview` - Preview production build

## 4. JSDoc Requirements - MANDATORY

Every function and array/object declaration MUST have proper JSDoc documentation.

### Functions - REQUIRED Tags
- `@param` - All parameters with types
- `@returns` - Return type (even for void functions)
- `@throws` - Any errors thrown

```javascript
// GOOD
/**
 * Fetches all available models from OpenRouter
 * @param {string} apiKey - OpenRouter API key
 * @returns {Promise<Array<Object>>} Array of model objects
 * @throws {Error} If API request fails
 */
function fetchModels(apiKey) { ... }

// BAD - NO JSDoc
function handleApiKeyEntry() { ... }
```

### Arrays/Objects - REQUIRED @type
- Every inline array `[]` or object `{}` needs `@type` JSDoc
- Exception: Variables assigned from well-documented function returns

```javascript
// GOOD
/** @type {Array<{role: string, content: string}>} */
const conversationHistory = [];

// GOOD - from documented function
const slots = generateTimeSlots(); // No @type needed

// BAD - NO @type
let selectedModel = null;
let conversationHistory = [];
```

### @typedef for Complex Types
```javascript
/**
 * @typedef {Object} ImageConfig
 * @property {string} imageSize - Image size (1K, 2K, 4K)
 * @property {string} aspectRatio - Aspect ratio (1:1, 16:9, etc)
 */
```

## 5. File Structure & Dependencies

### Project Files

| File | Purpose |
|------|---------|
| `index.html` | Vite entry HTML |
| `src/main.ts` | Main entry point, exports `init()` called on page load |
| `src/openrouter.ts` | OpenRouter API functions |
| `src/storage.ts` | OPFS storage module |
| `vite.config.ts` | Vite build configuration |
| `tsconfig.json` | TypeScript configuration |

### Module Loading (in index.html)
ES Modules loaded via `<script type="module" src="/src/main.ts"></script>`
main.ts imports all other modules

### Module Dependencies
- Bootstrap 5 via CDN (CSS in `<head>`, JS before `</body>`)

### Import Conventions

- **Path alias**: `@/` maps to `src/` directory
  - Example: `import { foo } from '@/openrouter'` imports `src/openrouter.ts`
- **Relative imports**: For same-directory files use `./`
  - Example: `import { bar } from './utils'` imports `src/utils.ts`
- **Import chain**: `index.html` → `src/main.ts` → other modules as needed

## 6. Code Formatting

- **Indentation**: 4 spaces
- **Line Length**: <140 characters
- **Semicolons**: Always use at end of statements
- **Braces**: Always use for blocks (`if (cond) { ... }`)
- **Spacing**: One space around operators, after commas, no trailing spaces
- **Blank Lines**: One between functions, two between major sections
- **Quotes**: Single quotes for strings, double for HTML attributes
- **Declarations**: Use `let` or `const` for all variable declarations MANDATORY

## 7. Naming Conventions

- **Variables/Functions**: camelCase (e.g., `parseCsvToObjects`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `OPENROUTER_BASE_URL`)
- **HTML IDs**: kebab-case (e.g., `api-key-input`)
- **Descriptive Names**: Avoid abbreviations
  - ❌ `p`, `a`, `tsStart`
  - ✅ `player`, `appointment`, `timeSlotStart`

## 8. Function Guidelines

- **Max 100 lines** per function (excluding comments)
- **Single Responsibility**: One function does one thing
- **Parameters**: Limit to <5; use objects for many params
- **Early Returns**: Use for clarity and reduced nesting
- **Arrow Functions**: Use for short callbacks only

```javascript
// BAD - 100+ lines doing multiple things
function submitAddPlayer() { /* ... */ }

// GOOD - split into smaller functions
function handleApiKeyEntry() { ... }
function handleGenerate() { ... }
```

## 9. Variables & Data Structures

- **Scope**: Minimize globals; use objects to group related data
- **Arrays**: Use literals `[]`, prefer Maps for key-value
- **Objects**: Use literals `{}`
- **Strings**: Template literals for interpolation `` `${var}` ``

## 10. Error Handling

- **Validation**: Check inputs early (`if (!apiKey) return;`)
- **Throws**: For critical errors; ALWAYS document with `@throws`
- **User Feedback**: Display errors via `displayError()` in UI
- **Logging**: Use `console.log` for debug only

## 11. Null Safety Patterns

Use modern JavaScript operators for clean null/undefined handling instead of explicit checks.

### Optional Chaining (`?.`)

**When to use**: Access properties or methods of objects that may be null/undefined
**Pattern**: Use `?.` instead of explicit `if` checks or ternaries

```javascript
// GOOD - Optional chaining
const resolution = entry.response.imageResolutions?.[index] ?? "1K";
const apiKey = STATE.currentConversation?.apiKey;

// BAD - Verbose checks
const resolution = entry.response.imageResolutions ? entry.response.imageResolutions[index] : "1K";
const apiKey = STATE.currentConversation && STATE.currentConversation.apiKey;
```

### Nullish Coalescing (`??`)

**When to use**: Provide fallback value only when left side is `null` or `undefined`
**Pattern**: `??` is safer than `||` (which also triggers on `false, 0, ""`)

```javascript
// GOOD - Nullish coalescing (only catches null/undefined)
const resolution = entry.response.imageResolutions?.[index] ?? "1K";

// AVOID - Logical OR (catches falsy values like 0, false, "")
const resolution = entry.response.imageResolutions?.[index] || "1K";
```

### Initialization with `??=`

**When to use**: Initialize arrays/objects only if they don't exist
**Pattern**: `??=` is shorthand for `x = x ?? default`

```javascript
// GOOD - Conditionally initialize
entry.response.imageResolutions ??= [];
entry.response.imageResolutions.push(resolution);
```

### Key Rule

**Prefer `?.` and `??` over explicit null checks**: These operators provide the same safety with cleaner, more readable code.

## 12. HTML/CSS & Bootstrap

- **Framework**: Bootstrap 5 via CDN
- **Custom CSS**: Inline `<style>` in index.html for layout-specific needs
- **Modals**: Bootstrap modals with `data-bs-dismiss`
- **Accessibility**: Add `aria-label` for inputs/buttons without labels

### Bootstrap JavaScript Usage - RESTRICTED

**CRITICAL**: Bootstrap JavaScript components should ONLY be used for modal dialogs. All other UI interactions should be implemented directly with captured references and native DOM APIs or helper functions.

**PERMITTED use cases:**
- Modal dialogs (showing/hiding modals with `bootstrap.Modal`)
- Modal event handling (`hidden.bs.modal`, etc.)
- Tooltip initialization for accessibility

**FORBIDDEN use cases:**
- Collapse components (use class toggling with captured references)
- Dropdowns (use click handlers with captured references)
- Toggles (use class toggling with captured references)
- Any other Bootstrap JavaScript components

**Pattern for non-modal interactions:**

```javascript
// GOOD - Use captured references with native DOM
function setupCollapse(reference) {
    const button = reference.querySelector("button[data-action='toggle']");
    const collapse = reference.querySelector(".collapse");
    
    button.addEventListener("click", async function() {
        collapse.classList.toggle("show");
        // logic here
    });
}

// BAD - Using Bootstrap JavaScript
const collapseInstance = new bootstrap.Collapse(collapseElement);
```

**Helper Function Pattern:**
For repeated UI interaction patterns, create helper functions instead of using Bootstrap JavaScript:

```javascript
// GOOD - Helper for toggle interactions
function toggleElementVisibility(element: HTMLElement, attributeName: string = "show"): boolean {
    const isExpanded = element.classList.toggle(attributeName);
    return isExpanded;
}
```

### DOM Insertions - MANDATORY

All DOM insertions MUST use HTML templates with `cloneNode(true)` and follow this exact pattern:

```html
<!-- conversation-item-template: Template for displaying a single conversation in the sidebar -->
<template id="conversation-item-template">
    <div class="conversation-item">
    [content goes here]
    </div>
</template>
```

```javascript
// GOOD - Correct template usage pattern
function addConversationItem(conversation) {
    const template = document.getElementById('conversation-item-template');
    const clone = template.content.cloneNode(true);
    const container = clone.firstElementChild; // Capture BEFORE adding to DOM
    container.textContent = conversation.title;
    document.getElementById('conversation-list').appendChild(clone);
    // Now 'container' is a reference to the element now in the DOM
    container.addEventListener('click', () => handleConversationClick(conversation.id));
}

// BAD - Incorrect patterns
function addConversationItem(conversation) {
    const div = document.createElement('div'); // No template
    div.textContent = conversation.title;
    document.getElementById('conversation-list').appendChild(div);
}
```

#### Template Requirements

1. **Every template must have a comment** describing what the template is for (placed on the line above the `<template>` tag)
2. **Templates must have a single interior div** - the template should contain exactly one root element (the `<div>` inside `<template>`)
3. **Capture reference before DOM insertion** - Always capture `clone.firstElementChild` BEFORE calling `appendChild`, `insertBefore`, or any method that adds the clone to the document
4. **Use the captured reference** for all subsequent DOM manipulations (adding event listeners, setting content, etc.)
5. **querySelector usage in template context** - `querySelector` should ONLY be used immediately after cloning a template to obtain references to elements within it. All event handlers and subsequent DOM manipulations MUST use the captured references obtained during template cloning. DO NOT use `querySelector` inside handlers or in any context after the template has been appended to the DOM.

## 13. Security & Best Practices

- **Input Sanitization**: Trim/validate all user inputs
- **XSS Prevention**: Use `textContent` not `innerHTML` with user data
- **No Secrets**: Never hardcode API keys; use user input or storage
- **PWA**: Service Worker handles offline caching

## 14. Version Control

- Agents must NEVER commit, push, or perform git operations
- Only make code changes; user handles all version control

## Code Review Checklist

Before submitting any code changes, verify:

- [ ] Every function has JSDoc with @param, @returns
- [ ] Every function that throws has @throws
- [ ] All variables use let or const (no var declarations)
- [ ] Every inline array `[]` has @type comment
- [ ] Every inline object `{}` has @type comment
- [ ] No single-letter variable names (except trivial loop counters)
- [ ] No abbreviations in names
- [ ] Functions under 100 lines
- [ ] All HTML IDs use kebab-case
- [ ] All DOM insertions use HTML templates with cloneNode(true)
- [ ] All templates have descriptive comments
- [ ] All templates have a single interior div
- [ ] References captured via clone.firstElementChild before DOM insertion
- [ ] querySelector only used during template cloning, not in handlers

By following these guidelines, agents maintain a clean, maintainable, and well-documented codebase.

## 15. TypeScript Usage

### Strict Type Checking

All TypeScript code uses `strict: true` mode. This includes:
- `noImplicitAny` - No implicit any types
- `strictNullChecks` - Strict null checking
- `strictFunctionTypes` - Strict function type checking
- Always strict mode enabled

### The `any` Type

**Strongly discouraged.** Only use `any` when absolutely necessary, and in those cases provide thorough documentation about what's contained.

**WHEN to use `any`:**

1. **Legacy library types** - When a library has poor or missing type definitions and you cannot create proper types
   ```typescript
   // Example: third-party library with no types
   const result: any = legacyLibrary.getData(); // Returns complex structure we don't know
   // Must document: result contains { data, metadata, timestamp }
   ```

2. **Bootstrap/Third-party runtime types** - When CDN-loaded types are imperfect but we need to interoperate
   ```typescript
   // Bootstrap type not perfect - need any for dynamic instance properties
   const tooltipInstance: any = new bootstrap.Tooltip(element);
   // Must document: tooltipInstance has { show(), hide(), dispose() } methods
   ```

3. **Temporary migration placeholder** - Only during active migration from JS to TS, not in final code
   ```typescript
   // TEMPORARY DURING MIGRATION - needs proper type after migration complete
   const externalData: unknown = getExternalData();
   // Must document: externalData expected structure
   ```

Use `unknown` instead of `any` where possible for better type safety.

**WHEN NOT to use `any`:**

- When you can define a proper type/interface/create type
- When TypeScript can infer the type
- When you can refine it to a more specific type
- As a shortcut to avoid defining proper types

**ALTERNATIVES to `any`:**

1. Use `unknown` when the type is unknown but will be checked
2. Define proper interfaces/types
3. Use union types for multiple possibilities
4. Use generics for type parameterization

**Documentation Requirements for `any`:**

If you must use `any`, you MUST add a comment immediately following explaining:

```typescript
const complexData: any = getComplexData();
// COMPLEX DATA STRUCTURE: Contains { field1: string, field2: number[], field3: { nested: object } }
// Reason: External API returns variable structure not properly typed yet
```

Without this documentation, use of `any` will be rejected in code review.
