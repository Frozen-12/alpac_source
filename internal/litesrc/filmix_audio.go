package litesrc

// Filmix's nginx-vod CDN can return index-v1.m3u8 (video only) and
// index-a1.m3u8 (audio only). Compose those renditions without transcoding.
// Different translations can be different edits: reject differing durations.
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"lampac-go/internal/proxylink"
)

const filmixAudioPrefix = "/proxy/filmix-audio/"

var filmixIsolatedSegment = regexp.MustCompile(`^seg-[0-9]+(?:-f[0-9]+)?-(a1|v1)\.ts$`)

func filmixAudioHeaders() map[string]string {
	return map[string]string{"User-Agent": filmixCDNUserAgent}
}

type filmixAudioSource struct{ name, audio, proxyAudio string }
type filmixAudioJob struct {
	mu                          sync.Mutex
	created                     time.Time
	client                      *http.Client
	video, proxyVideo, fallback string
	sources                     []filmixAudioSource // selected translation is first
	master                      string
	tracks                      int
}

var filmixAudioJobs = struct {
	sync.Mutex
	items map[string]*filmixAudioJob
}{items: make(map[string]*filmixAudioJob)}

func filmixAudioTrackURL(raw, track string) (string, error) {
	if track != "a1" && track != "v1" {
		return "", fmt.Errorf("invalid track")
	}
	u, err := url.Parse(strings.Split(raw, " or ")[0])
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", fmt.Errorf("invalid source")
	}
	// Premium legacy API may supply progressive /s/<hash>/<file>.mp4 URLs.
	if m := filmixHLSRe.FindStringSubmatch(u.Scheme + "://" + u.Host + u.Path); len(m) == 4 {
		u.Path = "/hls/" + m[3] + "/index.m3u8"
		q := u.Query()
		q.Set("hash", m[2])
		u.RawQuery = q.Encode()
	}
	if !strings.HasSuffix(u.Path, "/index.m3u8") {
		return "", fmt.Errorf("unsupported CDN layout")
	}
	u.Path = strings.TrimSuffix(u.Path, "index.m3u8") + "index-" + track + ".m3u8"
	u.Fragment = ""
	return u.String(), nil
}

// Require finite VOD playlists whose segment names explicitly identify the
// requested track; never label an ordinary muxed video as an audio rendition.
func filmixAudioDuration(body, track string) (float64, error) {
	if !strings.HasPrefix(strings.TrimSpace(body), "#EXTM3U") || !strings.Contains(body, "#EXT-X-ENDLIST") {
		return 0, fmt.Errorf("not a VOD playlist")
	}
	var duration float64
	segments, durations := 0, 0
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#EXTINF:") {
			n, err := strconv.ParseFloat(strings.Split(strings.TrimPrefix(line, "#EXTINF:"), ",")[0], 64)
			if err != nil || n <= 0 || math.IsNaN(n) || math.IsInf(n, 0) {
				return 0, fmt.Errorf("invalid duration")
			}
			duration += n
			durations++
		} else if line != "" && !strings.HasPrefix(line, "#") {
			u, err := url.Parse(line)
			base := ""
			if err == nil {
				base = u.Path[strings.LastIndex(u.Path, "/")+1:]
			}
			match := filmixIsolatedSegment.FindStringSubmatch(base)
			if err != nil || len(match) != 2 || match[1] != track {
				return 0, fmt.Errorf("not an isolated track")
			}
			segments++
		}
	}
	if segments == 0 || duration == 0 || durations != segments {
		return 0, fmt.Errorf("empty playlist")
	}
	return duration, nil
}

func (j *filmixAudioJob) duration(ctx context.Context, target, track string) (float64, error) {
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return 0, err
	}
	for k, v := range filmixAudioHeaders() {
		r.Header.Set(k, v)
	}
	resp, err := j.client.Do(r)
	if err != nil {
		return 0, fmt.Errorf("CDN request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("CDN status %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(b) > 1<<20 {
		return 0, fmt.Errorf("playlist read failed")
	}
	return filmixAudioDuration(string(b), track)
}

func filmixAudioName(name string) string {
	return strings.NewReplacer("\r", " ", "\n", " ", "\"", "'", "\\", " ").Replace(name)
}

func (j *filmixAudioJob) build(ctx context.Context) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.master != "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	videoDuration, err := j.duration(ctx, j.video, "v1")
	if err != nil {
		return err
	}
	good := make([]bool, len(j.sources))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i, source := range j.sources {
		wg.Add(1)
		go func(i int, source filmixAudioSource) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			d, err := j.duration(ctx, source.audio, "a1")
			good[i] = err == nil && math.Abs(d-videoDuration) <= 0.35
		}(i, source)
	}
	wg.Wait()
	if len(good) == 0 || !good[0] {
		return fmt.Errorf("selected audio unavailable")
	}
	var b strings.Builder
	b.WriteString("#EXTM3U\n#EXT-X-VERSION:3\n")
	for i, source := range j.sources {
		if !good[i] {
			continue
		}
		def := "NO"
		if i == 0 {
			def = "YES"
		}
		fmt.Fprintf(&b, "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"voices\",NAME=\"%s\",DEFAULT=%s,AUTOSELECT=%s,URI=\"%s\"\n",
			filmixAudioName(source.name), def, def, source.proxyAudio)
		j.tracks++
	}
	// Leave codecs/resolution to the actual media; Filmix includes both AVC and
	// HEVC, and titles are not necessarily 16:9. The chosen video stays intact.
	fmt.Fprintf(&b, "#EXT-X-STREAM-INF:BANDWIDTH=40000000,AUDIO=\"voices\"\n%s\n", j.proxyVideo)
	j.master = b.String()
	return nil
}

func registerFilmixAudioJob(job *filmixAudioJob) (string, error) {
	var id [24]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	key := hex.EncodeToString(id[:])
	now := time.Now()
	job.created = now
	filmixAudioJobs.Lock()
	defer filmixAudioJobs.Unlock()
	for k, j := range filmixAudioJobs.items {
		if now.Sub(j.created) > 3*time.Hour {
			delete(filmixAudioJobs.items, k)
		}
	}
	for len(filmixAudioJobs.items) >= 256 {
		oldest := ""
		var age time.Time
		for k, j := range filmixAudioJobs.items {
			if oldest == "" || j.created.Before(age) {
				oldest = k
				age = j.created
			}
		}
		delete(filmixAudioJobs.items, oldest)
	}
	filmixAudioJobs.items[key] = job
	return key + ".m3u8", nil
}

// A short-lived, unguessable capability under the existing /proxy namespace.
// Media children retain the normal encrypted proxy URLs, headers and IP policy.
func FilmixAudioMasterHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	key := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, filmixAudioPrefix), ".m3u8")
	filmixAudioJobs.Lock()
	job := filmixAudioJobs.items[key]
	filmixAudioJobs.Unlock()
	if job == nil || time.Since(job.created) > 3*time.Hour {
		http.NotFound(w, r)
		return
	}
	if err := job.build(r.Context()); err != nil {
		http.Redirect(w, r, job.fallback, http.StatusTemporaryRedirect)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "private, no-store")
	if r.Method == http.MethodGet {
		_, _ = io.WriteString(w, job.master)
	}
}

func (f *filmixChecker) writeAudioMux(w http.ResponseWriter, req *http.Request, root filmixPostRoot, s, t int, token string, links *proxylink.Manager) {
	fail := func() { writeJSON(w, http.StatusBadGateway, map[string]any{"error": "Filmix audio unavailable"}) }
	if links == nil {
		fail()
		return
	}
	season := root.PlayerLinks.Playlist[strconv.Itoa(s)]
	names := make([]string, 0, len(season))
	for name := range season {
		names = append(names, name)
	}
	sort.Strings(names)
	if t < 0 || t >= len(names) {
		fail()
		return
	}
	selected := filmixDecodeEpisodeSet(season[names[t]])
	episode, _ := strconv.Atoi(req.URL.Query().Get("e"))
	proxy := func(raw string) string {
		return hostFromRequest(req) + "/proxy/" + links.EncryptURIWithHeaders(raw, clientIP(req), "filmix", filmixAudioHeaders())
	}
	jobs := make(map[int]*filmixAudioJob)
	urls := make(map[int]string)
	for key, item := range selected {
		e := filmixEpisodeOrder(key, 0)
		if e <= 0 || e < episode-15 || e > episode+15 {
			continue
		}
		streams := f.buildEpisodeStreams(item, token, nil)
		if len(streams) == 0 {
			continue
		}
		best := strings.Split(streams[0]["url"], " or ")[0]
		video, err := filmixAudioTrackURL(best, "v1")
		if err != nil {
			continue
		}
		job := &filmixAudioJob{client: f.client, video: video, proxyVideo: proxy(video), fallback: proxy(best)}
		order := append([]string{names[t]}, append(append([]string{}, names[:t]...), names[t+1:]...)...)
		if len(order) > 32 {
			order = order[:32]
		}
		for _, name := range order {
			items := filmixDecodeEpisodeSet(season[name])
			for k, v := range items {
				if filmixEpisodeOrder(k, 0) != e {
					continue
				}
				q := f.buildEpisodeStreams(v, token, nil)
				if len(q) == 0 {
					break
				}
				audio, err := filmixAudioTrackURL(q[0]["url"], "a1")
				if err == nil {
					job.sources = append(job.sources, filmixAudioSource{name, audio, proxy(audio)})
				}
				break
			}
		}
		if len(job.sources) == 0 || job.sources[0].name != names[t] {
			continue
		}
		jobs[e] = job
	}
	current := jobs[episode]
	if current == nil || current.build(req.Context()) != nil {
		fail()
		return
	}
	for e, job := range jobs {
		if e == episode {
			continue
		}
		id, err := registerFilmixAudioJob(job)
		if err == nil {
			urls[e] = hostFromRequest(req) + filmixAudioPrefix + id
		}
	}
	if id, err := registerFilmixAudioJob(current); err == nil {
		urls[episode] = hostFromRequest(req) + filmixAudioPrefix + id
	}
	if urls[episode] == "" {
		fail()
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url": urls[episode], "tracks": current.tracks, "total": len(names), "episodes": urls})
}
