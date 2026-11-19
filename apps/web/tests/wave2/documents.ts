/** Read document text without the peer-name widgets that decorate remote carets. */
export function documentText(element: Element): string {
  const content = element.cloneNode(true) as Element
  content.querySelectorAll('[data-collab-caret]').forEach((caret) => caret.remove())
  return content.textContent ?? ''
}
