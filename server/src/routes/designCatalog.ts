import { Router, type Response } from "express";
import {
  createCustomDesignProfile,
  deleteCustomDesignProfile,
  designCatalogFacets,
  DesignCatalogError,
  getDesignCatalogProfile,
  readDesignCatalogLibrary,
  renderDesignCatalogPreview,
  searchDesignCatalog,
  updateDesignCatalogLibrary,
} from "../lib/designCatalog.js";

export const designCatalogRouter = Router();

function sendCatalogError(response: Response, error: unknown) {
  if (error instanceof DesignCatalogError) {
    return response.status(error.status).json({ error: error.message });
  }
  console.error("[design-catalog] operation failed:", error);
  return response.status(500).json({ error: "design catalogue operation failed" });
}

designCatalogRouter.get("/design-catalog/facets", async (_request, response) => {
  try {
    response.json(await designCatalogFacets());
  } catch (error) {
    sendCatalogError(response, error);
  }
});

designCatalogRouter.post("/design-catalog/search", async (request, response) => {
  try {
    response.json(await searchDesignCatalog(request.body));
  } catch (error) {
    sendCatalogError(response, error);
  }
});

designCatalogRouter.get("/design-catalog/profiles/:id", async (request, response) => {
  try {
    response.json(await getDesignCatalogProfile(request.params.id));
  } catch (error) {
    sendCatalogError(response, error);
  }
});

designCatalogRouter.get("/design-catalog/profiles/:id/preview.svg", async (request, response) => {
  try {
    const profile = await getDesignCatalogProfile(request.params.id);
    response.set({
      "Cache-Control": "private, max-age=300",
      "Content-Security-Policy": "default-src 'none'; style-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    response.type("image/svg+xml").send(renderDesignCatalogPreview(profile));
  } catch (error) {
    sendCatalogError(response, error);
  }
});

designCatalogRouter.get("/design-catalog/library", async (_request, response) => {
  try {
    response.json(await readDesignCatalogLibrary());
  } catch (error) {
    sendCatalogError(response, error);
  }
});

designCatalogRouter.put("/design-catalog/library", async (request, response) => {
  try {
    response.json(await updateDesignCatalogLibrary(request.body));
  } catch (error) {
    sendCatalogError(response, error);
  }
});

designCatalogRouter.post("/design-catalog/custom", async (request, response) => {
  try {
    response.status(201).json(await createCustomDesignProfile(request.body));
  } catch (error) {
    sendCatalogError(response, error);
  }
});

designCatalogRouter.delete("/design-catalog/custom/:id", async (request, response) => {
  try {
    response.json(await deleteCustomDesignProfile(request.params.id));
  } catch (error) {
    sendCatalogError(response, error);
  }
});
