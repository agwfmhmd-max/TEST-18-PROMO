import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ISCAE — 18ème Promotion | Diplômés" },
      {
        name: "description",
        content:
          "Plateforme officielle de la 18ème promotion de l’ISCAE Mauritanie : annuaire des diplômés et informations de cérémonie.",
      },
      { property: "og:title", content: "ISCAE — 18ème Promotion | Diplômés" },
      {
        property: "og:description",
        content: "Retrouvez les diplômés de l’ISCAE et consultez leur fiche académique officielle.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

/** الموقع الحقيقي (ملف واحد ثابت) يُخدَم من public/site/index.html */
function Index() {
  useEffect(() => {
    window.location.replace("/site/index.html");
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <a href="/site/index.html" className="text-sm font-medium text-primary underline">
        ISCAE — 18ème Promotion
      </a>
    </div>
  );
}
