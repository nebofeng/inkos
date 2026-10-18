/** 书籍工作区右侧已有会话栏：该书在左侧不再展示会话列表/新建入口。其它页照常。 */
export function shouldShowBookSessionEntry(
  bookWorkspaceId: string | undefined,
  bookId: string,
): boolean {
  return bookWorkspaceId !== bookId;
}
