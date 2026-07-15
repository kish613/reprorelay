/// <reference types="vite/client" />

declare module "virtual:reprorelay-data-source" {
  const dashboardDataSource: import("./lib/data-source.js").DashboardDataSource;
  export { dashboardDataSource };
}
