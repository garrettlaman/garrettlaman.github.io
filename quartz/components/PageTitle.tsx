import { joinSegments, pathToRoot } from "../util/path"
import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import { classNames } from "../util/lang"
import { i18n } from "../i18n"

const PageTitle: QuartzComponent = ({ fileData, cfg, displayClass }: QuartzComponentProps) => {
  const title = cfg?.pageTitle ?? i18n(cfg.locale).propertyDefaults.title
  const baseDir = pathToRoot(fileData.slug!)
  const iconPath = joinSegments(baseDir, "static/icon.png")
  return (
    <h2 class={classNames(displayClass, "page-title")}>
      <a href={baseDir}>
        <img class="Icon" src={iconPath} alt={title}/>
      </a>
    </h2>
  )
}

PageTitle.css = `
.page-title {
  font-size: 1.75rem;
  margin: 0;
  font-family: var(--titleFont);
}
.Icon {
  max-height: 75px;
  min-height: 25px;
  max-width: 75px;
  mid-width: 25px;
  display: block;
  margin: auto;
}
`

export default (() => PageTitle) satisfies QuartzComponentConstructor
